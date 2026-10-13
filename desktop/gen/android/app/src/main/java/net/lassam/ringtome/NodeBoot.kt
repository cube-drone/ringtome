package net.lassam.ringtome

import android.content.Context
import android.system.Os

/**
 * The cold start (plans/AUDIO.md, section 10): hrseAmp's media service woken by the car or a
 * headphone button with no window open, and so no node - which boots with the window, in Tauri's
 * setup. This boots it from here instead, the same way: the app's own data directory, so the same
 * node, the same port and the same sign-ins, whichever of the two came first (desktop/src/lib.rs,
 * `boot_once`).
 */
object NodeBoot {
  /** The shell's library: the node is linked into it (desktop/Cargo.toml, [lib]). */
  private const val LIBRARY = "horse_drawing_tycoon_2_lib"

  @Volatile private var up = false

  // desktop/src/lib.rs, `Java_net_lassam_ringtome_NodeBoot_boot`: true when the node is up.
  @JvmStatic private external fun boot(): Boolean

  /**
   * The node up, booting it if nothing has yet. Blocks while it boots - call it off the main thread.
   * False when it couldn't boot.
   */
  @Synchronized
  fun ensure(context: Context): Boolean {
    if (up) return true
    // Where Tauri puts the app's data on Android (its PathPlugin's `getDataDir`): the node reads it
    // from here, as the window's would from Tauri.
    Os.setenv("RINGTOME_DATA_DIRECTORY", context.dataDir.absolutePath, true)
    // Already loaded when the window came first; loading it is what hands the node the JVM.
    System.loadLibrary(LIBRARY)
    up = boot()
    return up
  }

  /** The node's address as it booted - `http://127.0.0.1:<port>` - or null before it has. */
  fun origin(): String? = Os.getenv("RINGTOME_NODE_URL")?.trimEnd('/')
}
