package net.lassam.ringtome

import android.content.Context
import android.net.Uri
import android.os.Bundle
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
 *
 * A shuffled list keeps its place between drives (Curtis, 2026-10-18: the car came back to the same
 * shuffle from its first song after an evening out, because the page, asleep, hadn't dealt a new
 * one). What the car played last in each - the song, where it is in the list, how far in - is kept
 * beside the lists, and the list picked again goes on from there. A mixtape plays from its top, as
 * a tape put in does. Once the page deals the list anew the place no longer matches its song, and
 * the new shuffle plays from its top.
 */
object AutoLibrary {
  private const val FILE = "hrseamp-lists.json"
  private const val PLACES = "hrseamp-places"

  const val ROOT = "root"
  private const val LIST = "list/"
  private const val SONG = "song/"

  // What a car-picked song carries, so the player can say which list it was in and where.
  private const val IN_LIST = "list"
  private const val KEY = "key"
  private const val AT = "at"

  @Volatile private var cached: JSONArray? = null

  /** A list to play: its songs, the one to start at, and how far into it (none: from the start). */
  data class Start(val songs: List<MediaItem>, val at: Int, val positionMs: Long? = null)

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
    val list = all.getJSONObject(i)
    val items = list.optJSONArray("items") ?: return emptyList()
    val id = list.optString("id")
    return (0 until items.length()).map { k ->
      val o = items.getJSONObject(k)
      val from = Bundle().apply {
        putString(IN_LIST, id)
        putString(KEY, o.optString("key"))
        putInt(AT, k)
      }
      song(context, o, "$SONG$i/$k", from)
    }
  }

  /**
   * A browsed item, played: a list from where the car left it (a mixtape, or a list never played,
   * from its top), or a song with the rest of its list after it.
   */
  fun expand(context: Context, mediaId: String): Start? {
    if (mediaId.startsWith(LIST)) {
      val songs = songsOf(context, mediaId)
      if (songs.isEmpty()) return null
      val extras = songs[0].mediaMetadata.extras
      val place = extras?.getString(IN_LIST)?.let { placeIn(context, it) } ?: return Start(songs, 0)
      val at = place.optInt(AT, -1)
      val same = at in songs.indices && songs[at].mediaMetadata.extras?.getString(KEY) == place.optString(KEY)
      return if (same) Start(songs, at, place.optLong("ms").coerceAtLeast(0)) else Start(songs, 0)
    }
    if (mediaId.startsWith(SONG)) {
      val (list, at) = mediaId.removePrefix(SONG).split('/').let {
        (it.getOrNull(0)?.toIntOrNull() ?: return null) to (it.getOrNull(1)?.toIntOrNull() ?: return null)
      }
      val songs = songsOf(context, "$LIST$list")
      return if (at in songs.indices) Start(songs, at) else null
    }
    return null
  }

  /** The car's place in a shuffled list, as it plays: the song playing, and how far into it. */
  fun remember(context: Context, item: MediaItem?, positionMs: Long) {
    val from = item?.mediaMetadata?.extras ?: return
    val list = from.getString(IN_LIST)?.takeIf(::keepsPlace) ?: return
    val place = JSONObject()
      .put(KEY, from.getString(KEY))
      .put(AT, from.getInt(AT))
      .put("ms", positionMs.coerceAtLeast(0))
    places(context).edit().putString(list, place.toString()).apply()
  }

  /** A list played to its end starts again from its top. */
  fun forget(context: Context, item: MediaItem?) {
    val list = item?.mediaMetadata?.extras?.getString(IN_LIST) ?: return
    places(context).edit().remove(list).apply()
  }

  private fun keepsPlace(list: String) = list.isNotEmpty() && !list.startsWith("mixtape:")

  private fun places(context: Context) = context.getSharedPreferences(PLACES, Context.MODE_PRIVATE)

  private fun placeIn(context: Context, list: String): JSONObject? {
    if (!keepsPlace(list)) return null
    val kept = places(context).getString(list, null) ?: return null
    return runCatching { JSONObject(kept) }.getOrNull()
  }

  /** A song as the player takes it: where it is, what it is, and (from a list) which and where. */
  fun song(context: Context, o: JSONObject, mediaId: String, from: Bundle? = null): MediaItem {
    val url = o.getString("url")
    val meta = MediaMetadata.Builder()
      .setTitle(o.optString("title"))
      .setArtist(o.optString("artist").ifEmpty { null })
      .setAlbumTitle(o.optString("album").ifEmpty { null })
      .setIsBrowsable(false)
      .setIsPlayable(true)
      .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
      .setExtras(from)
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
