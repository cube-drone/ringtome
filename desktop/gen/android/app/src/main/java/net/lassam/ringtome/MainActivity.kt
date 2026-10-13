package net.lassam.ringtome

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  // The system bars' sizes in CSS pixels, as JSON, for the page (node/html/index.html): the app
  // runs edge to edge, drawn under the clock and the home/back bar, and Android's web view doesn't
  // reliably report their sizes to CSS's env(safe-area-inset-*) (Curtis, 2026-10-08: the app bar
  // sat under the home/back buttons, the header under the clock). Written on the UI thread, read on
  // the web view's.
  @Volatile private var insets = "{}"

  // hrseAmp's player (PlayerBridge.kt, PlayerService.kt): the page's road to the phone's own player.
  private var player: PlayerBridge? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // The window goes; the music doesn't - only this window's hold on the player does.
  override fun onDestroy() {
    player?.release()
    player = null
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    // hrseAmp plays through the phone's player, not the page's (plans/AUDIO.md, section 10):
    // `__ringtomePlayer`, there before the first page loads, as the insets bridge is.
    player = PlayerBridge(this, webView).also { webView.addJavascriptInterface(it, "__ringtomePlayer") }
    // Before the first page loads, so its first script finds the bridge: `__ringtomeInsets.get()`.
    webView.addJavascriptInterface(object {
      @JavascriptInterface fun get(): String = insets
    }, "__ringtomeInsets")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, all ->
      val bars = all.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      insets = JSONObject()
        .put("top", (bars.top / density).toDouble())
        .put("right", (bars.right / density).toDouble())
        .put("bottom", (bars.bottom / density).toDouble())
        .put("left", (bars.left / density).toDouble())
        .toString()
      // A page already showing hears of the change now (a rotation); a page still loading reads
      // them as it starts.
      (view as WebView).evaluateJavascript(
        "window.__ringtomeInsetsChanged && window.__ringtomeInsetsChanged()", null
      )
      // ...and the web view still does whatever it does with insets itself - the keyboard among
      // them: this only listens.
      ViewCompat.onApplyWindowInsets(view, all)
    }
    ViewCompat.requestApplyInsets(webView)
  }
}
