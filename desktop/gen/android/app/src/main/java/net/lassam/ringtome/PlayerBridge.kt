package net.lassam.ringtome

import android.app.Activity
import android.content.ComponentName
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import org.json.JSONArray
import org.json.JSONObject

/**
 * The page's road to the phone's player (plans/AUDIO.md, section 10): `window.__ringtomePlayer`,
 * beside the insets bridge on [MainActivity]. player.js keeps the queue - the list, the shuffle, a
 * station's picks - and hands it here in order; [PlayerService] plays it, and what it plays comes
 * back as `window.__ringtomePlayerEvent(state)`, so the page's bar, the compact player and the
 * cassette show what the phone is doing even after the page has been asleep.
 *
 * The page's calls arrive on the bridge's own thread; the controller lives on the main one, so each
 * call is posted there.
 */
class PlayerBridge(private val activity: Activity, private val webView: WebView) {
  private val main = Handler(Looper.getMainLooper())
  private var controller: MediaController? = null

  /** The last state said, for a page that has just loaded to read at once. */
  @Volatile private var lastState = "{}"

  private val listener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) = say()
  }

  // While it plays, where it is, twice a second: the page's position bar.
  private val ticker = object : Runnable {
    override fun run() {
      say()
    }
  }

  init {
    val token = SessionToken(activity, ComponentName(activity, PlayerService::class.java))
    val future = MediaController.Builder(activity, token).buildAsync()
    future.addListener(
      {
        controller = runCatching { future.get() }.getOrNull()
        controller?.addListener(listener)
        say()
      },
      ContextCompat.getMainExecutor(activity),
    )
  }

  private fun on(block: (MediaController) -> Unit) {
    main.post { controller?.let(block) }
  }

  // The page's queue: `[{key, url, title, artist, album, art, durationMs}]`, each item's id its key.
  private fun items(json: String): List<MediaItem> {
    val all = JSONArray(json)
    return (0 until all.length()).map { i ->
      val song = all.getJSONObject(i)
      AutoLibrary.song(song, KEY + song.getString("key"))
    }
  }

  /** Play `queue` from `start`, `positionMs` in - or stand ready there, unless `autoplay`. */
  @JavascriptInterface
  fun play(queue: String, start: Int, positionMs: Long, autoplay: Boolean) = on { c ->
    c.setMediaItems(items(queue), start, positionMs)
    c.prepare()
    c.playWhenReady = autoplay
  }

  /** What comes after the song playing now, in place of what was going to (a new sort, the shuffle). */
  @JavascriptInterface
  fun upcoming(queue: String) = on { c ->
    val after = c.currentMediaItemIndex + 1
    if (after < c.mediaItemCount) c.removeMediaItems(after, c.mediaItemCount)
    c.addMediaItems(items(queue))
  }

  /** More at the end: a shuffle's next cycle, a station's next picks. */
  @JavascriptInterface
  fun append(queue: String) = on { c -> c.addMediaItems(items(queue)) }

  @JavascriptInterface
  fun toggle() = on { c ->
    if (c.isPlaying) {
      c.pause()
    } else {
      if (c.playbackState == Player.STATE_ENDED) c.seekTo(0, 0)
      c.play()
    }
  }

  @JavascriptInterface fun next() = on { c -> c.seekToNext() }

  // A few seconds in, back to this song's start; else the one before - the player's own rule.
  @JavascriptInterface fun previous() = on { c -> c.seekToPrevious() }

  @JavascriptInterface
  fun stop() = on { c ->
    c.pause()
    c.seekTo(0)
  }

  @JavascriptInterface fun seek(positionMs: Long) = on { c -> c.seekTo(positionMs) }

  /** The page's volume, levelling's turn-down already in it (section 9). */
  @JavascriptInterface fun volume(level: Float) = on { c -> c.volume = level.coerceIn(0f, 1f) }

  /** The lists Android Auto browses ([AutoLibrary]). */
  @JavascriptInterface fun library(json: String) = AutoLibrary.save(activity, json)

  @JavascriptInterface fun state(): String = lastState

  private fun say() {
    val c = controller ?: return
    val item = c.currentMediaItem
    val meta = item?.mediaMetadata
    val id = item?.mediaId ?: ""
    val state = JSONObject()
      .put("playing", c.isPlaying)
      .put("ended", c.playbackState == Player.STATE_ENDED)
      .put("index", c.currentMediaItemIndex)
      .put("count", c.mediaItemCount)
      .put("position", c.currentPosition)
      .put("duration", if (c.duration == C.TIME_UNSET) 0 else c.duration)
      // The page's own songs come back by their key; one the car picked, by what it is.
      .put("key", if (id.startsWith(KEY)) id.removePrefix(KEY) else "")
      .put("title", meta?.title?.toString() ?: "")
      .put("artist", meta?.artist?.toString() ?: "")
      .put("error", c.playerError?.errorCodeName ?: "")
      .toString()
    lastState = state
    webView.evaluateJavascript("window.__ringtomePlayerEvent && window.__ringtomePlayerEvent($state)", null)
    main.removeCallbacks(ticker)
    if (c.isPlaying) main.postDelayed(ticker, 500)
  }

  fun release() {
    main.removeCallbacks(ticker)
    controller?.release()
    controller = null
  }

  private companion object {
    const val KEY = "key/"
  }
}
