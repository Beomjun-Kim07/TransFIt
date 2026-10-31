package com.yj.departure

import android.os.Handler
import android.os.Looper
import java.net.HttpURLConnection
import java.net.URL

/** Minimal HTTP helpers (no extra dependencies). */
object Http {
    class HttpError(val code: Int) : Exception("HTTP $code")

    /** Blocking GET; throws [HttpError] for any status other than 200. Call off the main thread. */
    fun get(url: String, headers: Map<String, String> = emptyMap(), timeoutMs: Int = 8000): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            val code = conn.responseCode
            if (code != 200) throw HttpError(code)
            return conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    /** Runs [work] on a background thread and delivers the outcome on the main thread. */
    fun <T> async(work: () -> T, onDone: (Result<T>) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        Thread {
            val result = runCatching(work)
            main.post { onDone(result) }
        }.start()
    }
}
