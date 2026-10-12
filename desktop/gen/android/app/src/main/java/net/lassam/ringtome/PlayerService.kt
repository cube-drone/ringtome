package net.lassam.ringtome

import android.content.Intent
import android.webkit.CookieManager
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.util.concurrent.Executors

/**
 * hrseAmp's player on Android (plans/AUDIO.md, section 10; rulings 22 and 23). Tauri's web view
 * doesn't hand the page's Media Session to Android's, so the sound plays here instead: ExoPlayer,
 * holding Android's media session - the player in the notification shade and on the lock screen,
 * the headphones' buttons, the car - and, while it plays, a media-playback foreground service whose
 * notification is that player, so the music (and the node in this same process) carries on with
 * the screen off. Media3 posts the notification and moves in and out of the foreground itself.
 *
 * The page (player.js, through [PlayerBridge]) hands it the queue in order and follows what it
 * plays; Android Auto browses the lists the page last handed over ([AutoLibrary]).
 */
@OptIn(UnstableApi::class)
class PlayerService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null

  override fun onCreate() {
    super.onCreate()
    // Every request the player makes to the node carries the page's sign-in: Android's cookie store
    // is the web view's. Read per request, so a sign-in after the service started still counts.
    val http = DefaultHttpDataSource.Factory()
    val signedIn: DataSource.Factory = ResolvingDataSource.Factory(http) { spec ->
      val cookie = CookieManager.getInstance().getCookie(spec.uri.toString())
      if (cookie.isNullOrEmpty()) spec else spec.withAdditionalHeaders(mapOf("Cookie" to cookie))
    }
    val player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(DefaultMediaSourceFactory(signedIn))
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(C.USAGE_MEDIA)
          .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
          .build(),
        /* handleAudioFocus = */ true,
      )
      // Headphones unplugged, the music pauses, as every player does.
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    // A song that won't play - not on this phone yet, offline, not carried here - is passed over for
    // the next, so a car's music never stops on one bad file (section 7). The list's end stops it.
    player.addListener(object : Player.Listener {
      override fun onPlayerError(error: PlaybackException) {
        if (player.hasNextMediaItem()) {
          player.seekToNextMediaItem()
          player.prepare()
          player.play()
        }
      }
    })
    session = MediaLibrarySession.Builder(this, player, Library())
      // Covers by the same signed-in road: a person's own sounds' thumbnails are behind their sign-in.
      .setBitmapLoader(
        DataSourceBitmapLoader(MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor()), signedIn)
      )
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  // The app swiped away while nothing plays: nothing to keep alive. While it plays, it plays on.
  override fun onTaskRemoved(rootIntent: Intent?) {
    val player = session?.player
    if (player == null || !player.playWhenReady || player.mediaItemCount == 0) stopSelf()
  }

  override fun onDestroy() {
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }

  /** What a media browser - Android Auto - sees, and how an item it picks becomes a queue. */
  private inner class Library : MediaLibrarySession.Callback {
    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> =
      Futures.immediateFuture(LibraryResult.ofItem(AutoLibrary.root(), params))

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val all =
        if (parentId == AutoLibrary.ROOT) AutoLibrary.listItems(this@PlayerService)
        else AutoLibrary.songsOf(this@PlayerService, parentId)
      val from = (page.coerceAtLeast(0) * pageSize.coerceAtLeast(1)).coerceAtMost(all.size)
      val to = (from + pageSize.coerceAtLeast(1)).coerceAtMost(all.size)
      return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(all.subList(from, to)), params))
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val found =
        if (mediaId == AutoLibrary.ROOT) AutoLibrary.root()
        else AutoLibrary.listItems(this@PlayerService).firstOrNull { it.mediaId == mediaId }
          ?: AutoLibrary.expand(this@PlayerService, mediaId)?.let { (songs, at) -> songs[at] }
      return Futures.immediateFuture(
        if (found != null) LibraryResult.ofItem(found, null)
        else LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
      )
    }

    // An item from a controller, made playable: its address from its request metadata (what
    // crosses from the page's bridge), or the library's own for a browsed one.
    private fun playable(item: MediaItem): MediaItem {
      if (item.localConfiguration != null) return item
      item.requestMetadata.mediaUri?.let { return item.buildUpon().setUri(it).build() }
      return AutoLibrary.expand(this@PlayerService, item.mediaId)?.let { (songs, at) -> songs[at] } ?: item
    }

    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> =
      Futures.immediateFuture(mediaItems.map(::playable).toMutableList())

    // A list picked in the car plays from its top; a song picked plays with the rest of its list
    // after it, as a person picking one song from an album expects.
    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      if (mediaItems.size == 1) {
        AutoLibrary.expand(this@PlayerService, mediaItems[0].mediaId)?.let { (songs, at) ->
          return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(songs, at, startPositionMs))
        }
      }
      return Futures.immediateFuture(
        MediaSession.MediaItemsWithStartPosition(mediaItems.map(::playable), startIndex, startPositionMs)
      )
    }
  }
}
