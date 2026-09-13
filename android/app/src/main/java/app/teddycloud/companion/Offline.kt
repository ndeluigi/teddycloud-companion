package app.teddycloud.companion

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Stories downloaded for offline use: files/offline/<uid>.opus in the app's private storage.
 * The page asks for a download (StorieApp.download), polls StorieApp.offline() for progress,
 * and playNative() prefers the local file when it exists - so a car ride without signal still
 * plays. Downloads carry the WebView's session cookie like every other request to the site.
 */
object Offline {
    private val progress = ConcurrentHashMap<String, Int>()

    private fun dir(ctx: Context): File = File(ctx.filesDir, "offline").apply { mkdirs() }

    fun fileFor(ctx: Context, uid: String): File? =
        File(dir(ctx), "$uid.opus").takeIf { it.isFile && it.length() > 0 }

    fun status(ctx: Context): String {
        val uids = JSONArray()
        dir(ctx).listFiles()?.filter { it.isFile && it.name.endsWith(".opus") && it.length() > 0 }
            ?.forEach { uids.put(it.name.removeSuffix(".opus")) }
        val prog = JSONObject()
        progress.forEach { (k, v) -> prog.put(k, v) }
        return JSONObject().put("uids", uids).put("progress", prog).toString()
    }

    fun remove(ctx: Context, uid: String) {
        File(dir(ctx), "$uid.opus").delete()
        File(dir(ctx), "$uid.part").delete()
        progress.remove(uid)
    }

    fun download(ctx: Context, uid: String, url: String) {
        if (progress.containsKey(uid)) return
        progress[uid] = 0
        Thread {
            val part = File(dir(ctx), "$uid.part")
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 15000
                c.readTimeout = 60000
                CookieManager.getInstance().getCookie(url)?.let { c.setRequestProperty("Cookie", it) }
                if (c.responseCode != 200) throw Exception("HTTP ${c.responseCode}")
                val total = c.contentLengthLong
                var done = 0L
                c.inputStream.use { input ->
                    FileOutputStream(part).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            done += n
                            if (total > 0) progress[uid] = (done * 100 / total).toInt()
                        }
                    }
                }
                if (!part.renameTo(File(dir(ctx), "$uid.opus"))) throw Exception("rename failed")
            } catch (e: Exception) {
                part.delete()
            } finally {
                progress.remove(uid)
            }
        }.start()
    }
}
