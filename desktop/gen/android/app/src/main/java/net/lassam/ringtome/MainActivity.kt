package net.lassam.ringtome

import android.content.Intent
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

  // A `ringtome://` address handed to the app (plans/QR.md) - a scanned code, or a web page's "open in
  // the app" - waiting for the page to take it: `__ringtomeLink.take()`, which it asks on starting
  // and whenever it's told one arrived. The page checks it's an address of ours (pure/portable.js
  // `fromAppAddress`) before it goes anywhere.
  @Volatile private var link: String? = null
  private var web: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    linkOf(intent)
  }

  // The app already open (it's single-task): the address arrives here, and the page is told.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (linkOf(intent)) {
      web?.evaluateJavascript("window.__ringtomeLinkArrived && window.__ringtomeLinkArrived()", null)
    }
  }

  private fun linkOf(intent: Intent?): Boolean {
    val data = intent?.data ?: return false
    if (intent.action != Intent.ACTION_VIEW || data.scheme != "ringtome") return false
    link = data.toString()
    return true
  }

  // The window goes; the music doesn't - only this window's hold on the player does.
  override fun onDestroy() {
    player?.release()
    player = null
    web = null
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.addJavascriptInterface(object {
      @JavascriptInterface fun take(): String = (link ?: "").also { link = null }
    }, "__ringtomeLink")
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
