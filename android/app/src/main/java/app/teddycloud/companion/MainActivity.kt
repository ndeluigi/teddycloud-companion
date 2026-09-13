package app.teddycloud.companion

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONObject

/**
 * Storie's own web UI, full screen, with the two powers a browser does not have on this
 * site: the phone's NFC reader hands every ISO 15693 tag (figurines, coins) to the page,
 * and playback runs in a media service so it survives the screen turning off.
 *
 * Page -> app:  window.StorieApp.play/pause/resume/seek/stop/state/hasNfc/version/checkUpdate
 * App -> page:  window.StorieNative.onTag(uid)
 */
class MainActivity : ComponentActivity(), NfcAdapter.ReaderCallback {
    private lateinit var web: WebView
    private var nfc: NfcAdapter? = null
    private var updateChecked = false
    private var pendingMic: PermissionRequest? = null
    private val main = Handler(Looper.getMainLooper())

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    @Volatile private var stateJson = "{\"connected\":false}"
    private val tick = object : Runnable {
        override fun run() {
            publishState()
            main.postDelayed(this, 400)
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun version(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""

        @JavascriptInterface
        fun hasNfc(): Boolean = nfc != null

        @JavascriptInterface
        fun play(url: String, title: String, cover: String, uid: String, skipSeconds: Int) {
            main.post { playNative(url, title, cover, uid, skipSeconds) }
        }

        @JavascriptInterface fun pause() { main.post { controller?.pause() } }
        @JavascriptInterface fun resume() { main.post { controller?.play() } }
        @JavascriptInterface fun stop() { main.post { controller?.stop() } }
        @JavascriptInterface fun seek(seconds: Double) {
            main.post { controller?.seekTo((seconds * 1000).toLong()) }
        }

        /** Cached on the main thread every 400 ms; JS reads it whenever it likes. */
        @JavascriptInterface
        fun state(): String = stateJson

        @JavascriptInterface
        fun checkUpdate() { main.post { Updater.check(this@MainActivity, quiet = false) } }

        // offline stories (files/offline/<uid>.opus)
        @JavascriptInterface fun download(uid: String, url: String, title: String) { Offline.download(this@MainActivity, uid, url) }
        @JavascriptInterface fun removeOffline(uid: String) { Offline.remove(this@MainActivity, uid) }
        @JavascriptInterface fun offline(): String = Offline.status(this@MainActivity)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        // Android 15 draws every app edge to edge. Padding the WebView does not work (the
        // Cinema app learned that the hard way: the page ignores it), so the insets are handed
        // to the page as the same CSS variables a browser fills in from env(safe-area-inset-*).
        // One layout path for both surfaces; the keyboard shrinks the page instead.
        ViewCompat.setOnApplyWindowInsetsListener(web) { _, insets ->
            applyInsets()
            insets
        }
        ViewCompat.requestApplyInsets(web)
        WindowInsetsControllerCompat(window, web).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(Bridge(), "StorieApp")
        // "record a story": the page asks for the microphone through getUserMedia; grant it
        // once Android's RECORD_AUDIO permission is there (asked on first use)
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { request.deny(); return }
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingMic = request
                    ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.RECORD_AUDIO), 2)
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                applyInsets()          // a fresh document has no inline styles
                // the update endpoints sit behind the password; by now its cookie is in the jar
                if (!updateChecked && url != null && !url.contains("/login")) {
                    updateChecked = true
                    Updater.check(this@MainActivity)
                }
            }
        }
        // the site's "Scarica l'app Android" link is a download; inside the app it becomes
        // the manual update check
        web.setDownloadListener { url, _, _, _, _ ->
            if (url.contains("storie.apk")) Updater.check(this, quiet = false)
            else startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
        if (savedInstanceState == null) web.loadUrl(Updater.SITE) else web.restoreState(savedInstanceState)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // let the page close its own sheet first, then browser history, then leave
                web.evaluateJavascript("window.StorieBack ? StorieBack() : false") { handled ->
                    if (handled != "true") {
                        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
                    }
                }
            }
        })

        nfc = NfcAdapter.getDefaultAdapter(this)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 2) {
            val ok = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            pendingMic?.let { if (ok) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
            pendingMic = null
        }
    }

    override fun onStart() {
        super.onStart()
        val token = SessionToken(this, ComponentName(this, PlayerService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            try {
                controller = future.get()
                controller?.addListener(object : Player.Listener {
                    override fun onEvents(player: Player, events: Player.Events) { publishState() }
                })
                main.removeCallbacks(tick)
                main.post(tick)
            } catch (_: Exception) { }
        }, MoreExecutors.directExecutor())
    }

    override fun onStop() {
        main.removeCallbacks(tick)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controller = null
        stateJson = "{\"connected\":false}"
        super.onStop()
    }

    /**
     * Publish the window insets to the page in CSS pixels as --safetop/--safebot/--safeleft/
     * --saferight (inline properties outrank the stylesheet). Measured with
     * getRootWindowInsets rather than trusting a dispatch to arrive; refreshed on page finish,
     * resume and every inset change. The keyboard pads the view instead, so a focused field
     * is never covered.
     */
    private fun applyInsets() {
        val insets = ViewCompat.getRootWindowInsets(web) ?: return
        val bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        val density = resources.displayMetrics.density
        fun css(px: Int) = (px / density).toInt()
        web.setPadding(0, 0, 0, keyboard)
        val bottom = if (keyboard > 0) 0 else css(bars.bottom)
        web.evaluateJavascript(
            "(function(s){" +
            "s.setProperty('--safetop','${css(bars.top)}px');" +
            "s.setProperty('--safebot','${bottom}px');" +
            "s.setProperty('--safeleft','${css(bars.left)}px');" +
            "s.setProperty('--saferight','${css(bars.right)}px');" +
            "})(document.documentElement.style)", null)
    }

    override fun onResume() {
        super.onResume()
        applyInsets()          // rotation, a changed navigation mode, a resize
        // Reader mode: only ISO 15693 (NfcV) tags, no NDEF parsing (Tonie tags are not NDEF),
        // and no system "tag found" sound.
        val flags = NfcAdapter.FLAG_READER_NFC_V or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or
                NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
        nfc?.enableReaderMode(this, this, flags, null)
    }

    override fun onPause() {
        nfc?.disableReaderMode(this)
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    /** Binder thread. Android reports ISO 15693 UIDs LSB first; the site wants E0 04 03 … */
    override fun onTagDiscovered(tag: Tag) {
        var hex = tag.id.joinToString("") { "%02X".format(it) }
        if (!hex.startsWith("E0") && hex.endsWith("E0")) {
            hex = tag.id.reversed().joinToString("") { "%02X".format(it) }
        }
        main.post { web.evaluateJavascript("window.StorieNative && StorieNative.onTag('$hex')", null) }
    }

    private fun playNative(url: String, title: String, cover: String, uid: String, skipSeconds: Int) {
        val c = controller ?: return
        val local = Offline.fileFor(this, uid)          // downloaded for offline use?
        val item = MediaItem.Builder()
            .setUri(if (local != null) Uri.fromFile(local) else Uri.parse(url))
            .setMediaId(uid)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtist("Storie")
                    .setArtworkUri(if (cover.isEmpty()) null else Uri.parse(cover))
                    .build())
            .build()
        c.setMediaItem(item, skipSeconds * 1000L)
        c.prepare()
        c.play()
    }

    private fun publishState() {
        val c = controller
        stateJson = if (c == null) "{\"connected\":false}" else JSONObject()
            .put("connected", true)
            .put("playing", c.isPlaying)
            .put("buffering", c.playbackState == Player.STATE_BUFFERING)
            .put("ended", c.playbackState == Player.STATE_ENDED)
            .put("position", c.currentPosition / 1000.0)
            .put("duration", maxOf(0L, c.duration) / 1000.0)
            .put("uid", c.currentMediaItem?.mediaId ?: "")
            .toString()
    }
}
