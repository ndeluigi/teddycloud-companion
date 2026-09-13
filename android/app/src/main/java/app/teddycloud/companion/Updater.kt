package app.teddycloud.companion

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.CookieManager
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * In-app updater: publishing (scripts/publish_apk.ps1) writes a
 * sidecar next to the APK - {versionCode, versionName, sha256} - and the app compares it
 * with its own version on every launch. When the site has a newer build we download it with
 * the WebView's session cookie (the site is behind the Storie password), check the hash, and
 * hand the file to Android's package installer. Android never allows a silent sideload
 * install, so the last step is always one confirmation tap.
 */
object Updater {
    const val SITE = BuildConfig.SITE   // android/companion.properties -> site=
    private const val MANIFEST_URL = "$SITE/storie.apk.json"
    private const val APK_URL = "$SITE/storie.apk"

    /** quiet=true (launch check) says nothing unless there is something to install. */
    fun check(activity: Activity, quiet: Boolean = true) {
        Thread {
            var newer: JSONObject? = null
            var failure: String? = null
            try {
                val published = JSONObject(get(MANIFEST_URL))
                val mine = PackageInfoCompat.getLongVersionCode(
                    activity.packageManager.getPackageInfo(activity.packageName, 0))
                if (published.optLong("versionCode", 0) > mine) newer = published
            } catch (e: Exception) {
                failure = e.message ?: "non raggiungibile"
            }
            val found = newer
            on(activity) {
                when {
                    found != null -> offer(activity, found.optString("versionName", "?"),
                                           found.optString("sha256", ""))
                    quiet -> {}
                    failure != null -> toast(activity, "Aggiornamenti non raggiungibili ($failure)")
                    else -> toast(activity, "Storie è già aggiornata")
                }
            }
        }.start()
    }

    private fun offer(activity: Activity, version: String, sha256: String) {
        AlertDialog.Builder(activity)
            .setTitle("Nuova versione")
            .setMessage("Storie $version è disponibile. Vuoi aggiornare?")
            .setPositiveButton("Aggiorna") { _, _ -> install(activity, sha256) }
            .setNegativeButton("Più tardi", null)
            .show()
    }

    private fun install(activity: Activity, sha256: String) {
        // one-time per phone: Android asks whether this app may install apps
        if (!activity.packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(activity)
                .setMessage("Consenti a Storie di installare aggiornamenti, poi premi di nuovo Aggiorna.")
                .setPositiveButton("Apri impostazioni") { _, _ ->
                    activity.startActivity(
                        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                               Uri.parse("package:" + activity.packageName)))
                }
                .setNegativeButton("Annulla", null)
                .show()
            return
        }
        val progress = AlertDialog.Builder(activity)
            .setMessage("Scaricamento in corso…")
            .setCancelable(false)
            .show()
        Thread {
            var apk: Uri? = null
            var failure: String? = null
            try {
                apk = download(activity, sha256)
            } catch (e: Exception) {
                failure = e.message ?: "errore"
            }
            val ready = apk
            on(activity) {
                progress.dismiss()
                if (ready == null) {
                    toast(activity, "Aggiornamento fallito: $failure")
                } else {
                    activity.startActivity(
                        Intent(Intent.ACTION_VIEW)
                            .setDataAndType(ready, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                }
            }
        }.start()
    }

    /** Fetch the APK, verify the published hash, expose it to the installer. */
    private fun download(ctx: Context, sha256: String): Uri {
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
        val apk = File(dir, "storie-update.apk")
        val c = open(APK_URL)
        val digest = MessageDigest.getInstance("SHA-256")
        c.inputStream.use { input ->
            FileOutputStream(apk).use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    digest.update(buf, 0, n)
                }
            }
        }
        val got = digest.digest().joinToString("") { "%02x".format(it) }
        if (sha256.isNotEmpty() && !sha256.equals(got, ignoreCase = true)) {
            apk.delete()
            throw Exception("file corrotto, scaricamento scartato")
        }
        return FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", apk)
    }

    private fun get(url: String): String =
        open(url).inputStream.bufferedReader().use { it.readText() }

    /** Both endpoints sit behind the Storie password, whose cookie lives in the WebView. */
    private fun open(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 60000
        c.instanceFollowRedirects = false
        CookieManager.getInstance().getCookie(url)?.let { c.setRequestProperty("Cookie", it) }
        if (c.responseCode != 200) throw Exception("HTTP ${c.responseCode}")
        return c
    }

    private fun on(activity: Activity, block: () -> Unit) {
        Handler(Looper.getMainLooper()).post {
            if (!activity.isFinishing && !activity.isDestroyed) block()
        }
    }

    private fun toast(ctx: Context, text: String) =
        Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show()
}
