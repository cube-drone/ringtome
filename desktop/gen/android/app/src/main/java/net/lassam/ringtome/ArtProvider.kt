package net.lassam.ringtome

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.webkit.CookieManager
import java.io.File
import java.io.FileNotFoundException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Songs' covers for Android Auto (Curtis, 2026-10-12: "the song thumbnails don't display in the
 * car"). A cover is an address on this phone's node, behind the person's sign-in; the shade and the
 * lock screen get theirs through the player's own signed-in loader (PlayerService), but the car is
 * another app, fetching for itself, and the node turns it away. So the car is handed a `content://`
 * address instead, served here, in this process, with the sign-in - and only to the car: the
 * provider isn't exported, and Android Auto alone is granted reading it ([grantTo]).
 *
 * It serves thumbnails and nothing else - a path ending `/thumb` on the node, never a song or a
 * document - kept in the app's cache, which Android may empty whenever it likes, and asked for again
 * after a day: a cover's address doesn't change when the cover does.
 */
class ArtProvider : ContentProvider() {
  companion object {
    /** Android Auto on a phone: the app that draws a car's screens. */
    private const val AUTO = "com.google.android.projection.gearhead"

    private fun authority(context: Context) = "${context.packageName}.art"

    /** A cover's node address as the car can read it; anything else as it was. */
    fun forCar(context: Context, art: String?): Uri? {
      if (art.isNullOrEmpty()) return null
      val uri = Uri.parse(art)
      if ((uri.host != "127.0.0.1" && uri.host != "localhost") || !serves(uri.path)) return uri
      return Uri.Builder()
        .scheme("content")
        .authority(authority(context))
        .encodedPath(uri.encodedPath)
        .encodedQuery(uri.encodedQuery)
        .build()
    }

    /** Android Auto may read every cover here, once, for as long as the phone is on. */
    fun grantTo(context: Context) {
      runCatching {
        context.grantUriPermission(
          AUTO,
          Uri.parse("content://${authority(context)}/"),
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
      }
    }

    private fun serves(path: String?) = path != null && path.startsWith("/") && path.endsWith("/thumb")

    private const val FRESH_MS = 24 * 60 * 60 * 1000L
  }

  override fun onCreate() = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    val context = context ?: throw FileNotFoundException("no context")
    if (mode != "r" || !serves(uri.path)) throw FileNotFoundException(uri.toString())
    val wanted = (uri.encodedPath ?: "") + (uri.encodedQuery?.let { "?$it" } ?: "")
    val dir = File(context.cacheDir, "art").apply { mkdirs() }
    val name = MessageDigest.getInstance("SHA-256").digest(wanted.toByteArray())
      .joinToString("") { "%02x".format(it) }
    val kept = File(dir, name)
    val stale = !kept.exists() || System.currentTimeMillis() - kept.lastModified() > FRESH_MS
    // A cover kept from before still shows when the node can't be asked: better than none.
    if (stale) runCatching { fetch(context, wanted, kept) }.onFailure { if (!kept.exists()) throw it }
    return ParcelFileDescriptor.open(kept, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  // From the node, signed in as the page is: Android's cookie store is the web view's. A car asking
  // before anything else woke the app finds the node booted first (a binder thread: it may wait).
  private fun fetch(context: Context, wanted: String, into: File) {
    if (!NodeBoot.ensure(context)) throw FileNotFoundException("the node isn't up")
    val origin = NodeBoot.origin() ?: throw FileNotFoundException("the node has no address")
    val address = origin + wanted
    val http = URL(address).openConnection() as HttpURLConnection
    try {
      http.connectTimeout = 5_000
      http.readTimeout = 10_000
      CookieManager.getInstance().getCookie(address)?.let { http.setRequestProperty("Cookie", it) }
      if (http.responseCode != 200) throw FileNotFoundException("$wanted: ${http.responseCode}")
      val part = File(into.parentFile, "${into.name}.part")
      http.inputStream.use { input -> part.outputStream().use { input.copyTo(it) } }
      if (!part.renameTo(into)) throw FileNotFoundException("couldn't keep $wanted")
    } finally {
      http.disconnect()
    }
  }

  override fun getType(uri: Uri): String = "image/*"

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ) = 0
}
