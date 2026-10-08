//! Certificates on Android (2026-10-08, the first phone build's log): every HTTPS request the node
//! made panicked with "Expect rustls-platform-verifier to be initialized" - the DHT's relay
//! publishing, fragment revalidation, fetching a missing body. iroh's QUIC, its relays, pkarr and
//! reqwest all check certificates with `rustls-platform-verifier`, which on Android asks the
//! platform's own trust manager through the JVM, and so needs the JVM and the app's `Context`
//! handed to it once, before the first handshake. Peer sync never noticed: iroh's own transport
//! authenticates by key, not by certificate.
//!
//! The JVM comes from `JNI_OnLoad`, which Android calls as it loads this library - before any of
//! our code runs - and the `Context` is the Application, asked of `ActivityThread`. [`init`] runs
//! in `setup`, before the node starts. Its Kotlin half (the verifier's `CertificateVerifier`) is
//! added to the Android build by `tools/android-project.sh`.

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, Ordering};

use jni::{jni_sig, jni_str, JavaVM};

static VM: AtomicPtr<jni::sys::JavaVM> = AtomicPtr::new(std::ptr::null_mut());

/// Android's hook as it loads the library: the one moment the JVM is handed over unasked.
#[no_mangle]
pub extern "system" fn JNI_OnLoad(vm: *mut jni::sys::JavaVM, _reserved: *mut c_void) -> jni::sys::jint {
    VM.store(vm, Ordering::SeqCst);
    jni::sys::JNI_VERSION_1_6
}

/// Hand the verifier the JVM and the Application. Once; a second call is a no-op in the crate.
pub fn init() -> anyhow::Result<()> {
    let raw = VM.load(Ordering::SeqCst);
    anyhow::ensure!(!raw.is_null(), "JNI_OnLoad never ran, so there is no JVM to hand over");
    // SAFETY: the pointer is the process's JavaVM, as Android passed it to JNI_OnLoad; it lives as
    // long as the process.
    let vm = unsafe { JavaVM::from_raw(raw) };
    vm.attach_current_thread(|env| -> Result<(), jni::errors::Error> {
        let app = env
            .call_static_method(
                jni_str!("android/app/ActivityThread"),
                jni_str!("currentApplication"),
                jni_sig!(() -> android.app.Application),
                &[],
            )?
            .l()?;
        rustls_platform_verifier::android::init_with_env(env, app)
    })?;
    Ok(())
}
