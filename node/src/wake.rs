//! A phone's node, back from suspension (plans/MOBILE.md, the iOS section's _Suspension_,
//! 2026-11-26).
//!
//! iOS freezes an app a few seconds after it leaves the screen, and while it is frozen the
//! system may take back its sockets - Apple's word is "reclaim" - the HTTP listener the window
//! talks to and iroh's UDP sockets alike. Nothing in the process is told. Back on screen, a
//! reclaimed listener either fails every `accept` or never accepts again, and the page goes
//! dark with the node still alive behind it.
//!
//! So the node's listener is one that can be bound again ([`WakingListener`]), on the SAME
//! address - the window's origin is that port - and the shell says when the app comes back
//! ([`Waking::resumed`]). Bound again when:
//!
//! - **`accept` fails for a reason that is not one connection's** (axum's own listener sleeps a
//!   second and tries again, forever): after the second, try binding the address. If the port
//!   is still ours - `AddrInUse` - the old listener is alive and stays (that is the too-many-
//!   open-files case, which axum's pause was for); if the bind succeeds, the old one was dead
//!   and the new one takes over.
//! - **the app is back** ([`Waking::resumed`]): the same test, since a reclaimed listener may
//!   simply never wake. And iroh is told the network may have changed
//!   ([`iroh::Endpoint::network_change`]), which rebinds its sockets if they need it - harmless
//!   when nothing changed, its documentation says.
//!
//! A desktop or a server never calls `resumed`, and its listener never fails that way, so for
//! them this is axum's listener with a test it never needs.
//!
//! **Not handled yet:** a reclaimed port that stays taken. If the system keeps the dead
//! listener's port, the bind fails with `AddrInUse` and looks exactly like a live listener; the
//! answer would be another port and the window sent to it. Unseen until a real phone shows it.
//!
//! **The test reclaim:** the simulator shares the Mac's network and reclaims nothing, so a
//! suspension there costs no socket. With `RINGTOME_TEST_RECLAIM_ON_SUSPEND=1` in a debug build,
//! [`Waking::suspended`] drops the listener the way iOS would - its port freed, nothing
//! accepting - and only a `resumed` brings it back: the recovery, exercised for real.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

/// The shell's handle on its node's lifecycle: cheap to clone, and kept after [`crate::serve`]
/// takes the [`crate::Bound`].
#[derive(Clone)]
pub struct Waking {
    inner: Arc<Inner>,
}

struct Inner {
    /// The app is back: test the listener.
    resumed: Notify,
    /// The test reclaim: drop the listener (see the module's last paragraph).
    reclaim: Notify,
    endpoint: iroh::Endpoint,
}

impl Waking {
    pub(crate) fn new(endpoint: iroh::Endpoint) -> Self {
        Self { inner: Arc::new(Inner { resumed: Notify::new(), reclaim: Notify::new(), endpoint }) }
    }

    /// The app left the screen. Nothing to do but say so - the system may freeze the process at
    /// any moment after this - unless the test reclaim is asked for.
    pub fn suspended(&self) {
        tracing::info!("suspended");
        if test_reclaim() {
            self.inner.reclaim.notify_one();
        }
    }

    /// The app is back on screen: tell iroh the network may have changed, and have the listener
    /// test itself.
    pub async fn resumed(&self) {
        tracing::info!("resumed: checking the listener and the network");
        self.inner.resumed.notify_one();
        self.inner.endpoint.network_change().await;
    }
}

/// `RINGTOME_TEST_RECLAIM_ON_SUSPEND=1`, honoured by a debug build only: a release build on
/// somebody's phone has no business dropping its listener on purpose.
fn test_reclaim() -> bool {
    cfg!(debug_assertions)
        && std::env::var("RINGTOME_TEST_RECLAIM_ON_SUSPEND").is_ok_and(|v| v == "1")
}

/// The node's HTTP listener, bound again on its own address when it dies (the module's comment).
pub struct WakingListener {
    held: Option<TcpListener>,
    /// Dropped by the test reclaim: bound again only when the app is back.
    asleep: bool,
    addr: SocketAddr,
    waking: Arc<Inner>,
}

impl WakingListener {
    pub(crate) fn new(listener: TcpListener, waking: &Waking) -> std::io::Result<Self> {
        let addr = listener.local_addr()?;
        Ok(Self { held: Some(listener), asleep: false, addr, waking: waking.inner.clone() })
    }

    /// Bind our address afresh if it is free - which means the listener we held was dead.
    /// `AddrInUse` means the port is still ours: the listener lives, and stays.
    async fn bind_if_dead(&mut self, why: &str) {
        match TcpListener::bind(self.addr).await {
            Ok(fresh) => {
                tracing::warn!(addr = %self.addr, why, "the listener was gone; bound it again");
                self.held = Some(fresh);
                self.asleep = false;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && self.held.is_some() => {
                tracing::debug!(addr = %self.addr, why, "the listener is alive");
            }
            Err(e) => {
                tracing::warn!(addr = %self.addr, why, error = %e, "could not bind the listener again");
            }
        }
    }
}

/// What woke the accept loop.
enum Woke {
    Accepted(std::io::Result<(TcpStream, SocketAddr)>),
    Resumed,
    Reclaim,
}

/// One connection's trouble, not the listener's - axum's own list.
fn is_connection_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
    )
}

impl axum::serve::Listener for WakingListener {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        loop {
            let woke = match &self.held {
                Some(listener) => tokio::select! {
                    accepted = listener.accept() => Woke::Accepted(accepted),
                    () = self.waking.resumed.notified() => Woke::Resumed,
                    () = self.waking.reclaim.notified() => Woke::Reclaim,
                },
                // Asleep (the test reclaim): only the app's return binds it again.
                None if self.asleep => {
                    self.waking.resumed.notified().await;
                    Woke::Resumed
                }
                // Lost and not bound again yet: a second, then try.
                None => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    self.bind_if_dead("retrying").await;
                    continue;
                }
            };
            match woke {
                Woke::Accepted(Ok(accepted)) => return accepted,
                Woke::Accepted(Err(e)) if is_connection_error(&e) => {}
                Woke::Accepted(Err(e)) => {
                    tracing::warn!(addr = %self.addr, error = %e, "accept failed");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    self.bind_if_dead("accept failed").await;
                }
                Woke::Resumed => self.bind_if_dead("resumed").await,
                Woke::Reclaim => {
                    tracing::warn!(addr = %self.addr, "test reclaim: dropping the listener, as iOS may");
                    self.held = None;
                    self.asleep = true;
                }
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        Ok(self.addr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The test `bind_if_dead` rests on, on whatever system runs it: a second bind of an address
    /// a live listener holds fails with `AddrInUse` - tokio sets `SO_REUSEADDR`, which must not
    /// let two listeners share a port.
    #[tokio::test]
    async fn a_live_listener_keeps_its_port() {
        let live = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = live.local_addr().unwrap();
        let second = TcpListener::bind(addr).await;
        assert_eq!(second.err().map(|e| e.kind()), Some(std::io::ErrorKind::AddrInUse));
        drop(live);
        TcpListener::bind(addr).await.expect("free once the first is gone");
    }

    /// Reclaimed while suspended, nothing answers; resumed, the same port answers again.
    #[tokio::test]
    async fn a_reclaimed_listener_comes_back_on_resume() {
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
            .bind()
            .await
            .expect("an endpoint for the test");
        let waking = Waking::new(endpoint);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let listener = WakingListener::new(listener, &waking).unwrap();
        let app = axum::Router::new().route("/health", axum::routing::get(|| async { "ok" }));
        tokio::spawn(async move { axum::serve(listener, app).await });

        let get = || async move {
            let mut stream = TcpStream::connect(addr).await?;
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            stream
                .write_all(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                .await?;
            let mut said = String::new();
            stream.read_to_string(&mut said).await?;
            std::io::Result::Ok(said)
        };
        assert!(get().await.unwrap().ends_with("ok"), "answers at first");

        // What the test reclaim does, without the environment variable.
        waking.inner.reclaim.notify_one();
        let gone = async {
            for _ in 0..50 {
                if get().await.is_err() {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            false
        };
        assert!(gone.await, "nothing answers once the listener is reclaimed");

        waking.resumed().await;
        let back = async {
            for _ in 0..50 {
                if let Ok(said) = get().await {
                    return said;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            String::new()
        };
        assert!(back.await.ends_with("ok"), "the same port answers after the resume");
    }
}
