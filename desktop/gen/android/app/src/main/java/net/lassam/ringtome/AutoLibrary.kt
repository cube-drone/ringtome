package net.lassam.ringtome

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * What Android Auto can browse (plans/AUDIO.md, section 10): the lists hrseAmp hands over while it
 * is open - its mixtapes in their order, everything shuffled, each saved filter, each radio station
 * as a long run of its picks - kept in a file, so the car browses the last set the page gave even
 * when the page is gone. A little stale at worst; the page refreshes it whenever its library moves.
 *
 * The page's shape: `{"lists": [{"id", "title", "items": [{"key", "url", "title", "artist",
 * "album", "art", "durationMs"}]}]}` - every `url` an address on this phone's own node.
 */
object AutoLibrary {
  private const val FILE = "hrseamp-lists.json"

  const val ROOT = "root"
  private const val LIST = "list/"
  private const val SONG = "song/"

  @Volatile private var cached: JSONArray? = null

  fun save(context: Context, json: String) {
    val lists = JSONObject(json).optJSONArray("lists") ?: JSONArray()
    File(context.filesDir, FILE).writeText(JSONObject().put("lists", lists).toString())
    cached = lists
  }

  private fun lists(context: Context): JSONArray {
    cached?.let { return it }
    val file = File(context.filesDir, FILE)
    val read = if (file.exists()) {
      runCatching { JSONObject(file.readText()).optJSONArray("lists") }.getOrNull()
    } else {
      null
    }
    return (read ?: JSONArray()).also { cached = it }
  }

  fun root(): MediaItem =
    MediaItem.Builder()
      .setMediaId(ROOT)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle("hrseAmp")
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
          .build()
      )
      .build()

  /** The lists, each a folder that is also playable from its top. */
  fun listItems(context: Context): List<MediaItem> {
    val all = lists(context)
    return (0 until all.length()).map { i ->
      val list = all.getJSONObject(i)
      MediaItem.Builder()
        .setMediaId("$LIST$i")
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(list.optString("title"))
            .setIsBrowsable(true)
            .setIsPlayable(true)
            .setMediaType(MediaMetadata.MEDIA_TYPE_PLAYLIST)
            .build()
        )
        .build()
    }
  }

  /** One list's songs, or none for an id that isn't a list. */
  fun songsOf(context: Context, mediaId: String): List<MediaItem> {
    val i = mediaId.removePrefix(LIST).toIntOrNull() ?: return emptyList()
    val all = lists(context)
    if (!mediaId.startsWith(LIST) || i !in 0 until all.length()) return emptyList()
    val items = all.getJSONObject(i).optJSONArray("items") ?: return emptyList()
    return (0 until items.length()).map { k -> song(context, items.getJSONObject(k), "$SONG$i/$k") }
  }

  /** A browsed item, played: a list from its top, or a song with the rest of its list after it. */
  fun expand(context: Context, mediaId: String): Pair<List<MediaItem>, Int>? {
    if (mediaId.startsWith(LIST)) {
      val songs = songsOf(context, mediaId)
      return if (songs.isEmpty()) null else songs to 0
    }
    if (mediaId.startsWith(SONG)) {
      val (list, at) = mediaId.removePrefix(SONG).split('/').let {
        (it.getOrNull(0)?.toIntOrNull() ?: return null) to (it.getOrNull(1)?.toIntOrNull() ?: return null)
      }
      val songs = songsOf(context, "$LIST$list")
      return if (at in songs.indices) songs to at else null
    }
    return null
  }

  /** A song as the player takes it: where it is, and what it is. */
  fun song(context: Context, o: JSONObject, mediaId: String): MediaItem {
    val url = o.getString("url")
    val meta = MediaMetadata.Builder()
      .setTitle(o.optString("title"))
      .setArtist(o.optString("artist").ifEmpty { null })
      .setAlbumTitle(o.optString("album").ifEmpty { null })
      .setIsBrowsable(false)
      .setIsPlayable(true)
      .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
    // The cover as the car can read it (ArtProvider): the node's address needs a sign-in it hasn't.
    ArtProvider.forCar(context, o.optString("art"))?.let { meta.setArtworkUri(it) }
    if (o.optLong("durationMs") > 0) meta.setDurationMs(o.optLong("durationMs"))
    return MediaItem.Builder()
      .setMediaId(mediaId)
      .setUri(url)
      // The address rides the request metadata too: it's what crosses from a controller to the
      // session, where an item's own URI may not (PlayerService.onAddMediaItems).
      .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(Uri.parse(url)).build())
      .setMediaMetadata(meta.build())
      .build()
  }
}
