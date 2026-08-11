//! The Tauri spike harness: a window, and a loopback HTTP server to serve the probe page from.
//!
//! Why there is a server in here at all: the two questions this spike exists to answer
//! (see ../README.md) can both depend on the page's ORIGIN, and DESKTOP.md's architecture puts
//! the UI on `http://127.0.0.1:<port>` served by the node while its stable-origin trick puts it
//! on a custom scheme. Those are different security contexts, so the harness serves the same
//! probe page both ways and `SPIKE_ORIGIN` picks which:
//!
//!   SPIKE_ORIGIN=http    (default)  window -> http://127.0.0.1:<ephemeral>/index.html
//!   SPIKE_ORIGIN=scheme            window -> the Tauri asset protocol (tauri://localhost)
//!
//! In BOTH modes the server also runs, because it owns `POST /save/<name>` - the escape hatch
//! that gets encoded video out of the webview and onto disk for cross-checking against the Rust
//! decoders. Webview download support is uneven; a POST is not.
//!
//! Deliberately hand-rolled and deliberately small: GET static files, POST one save route,
//! loopback only, one thread per connection. It is a spike fixture, not a server - if it ever
//! wants a feature, that is a signal the spike has outgrown its question.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Cap on a saved artifact. The `frames` lane emits tens of megabytes of APNG by design
/// (video-ingest's README measures ~58MB for 20s), so this is generous on purpose - but it is
/// still a bound, because an unbounded read from a socket is how a fixture becomes a footgun.
const MAX_SAVE_BYTES: usize = 256 * 1024 * 1024;

/// Percent-encode for a query-string value. Tiny by hand rather than pulling a crate in: the only
/// inputs are version strings, which need spaces, parens and dots survived.
fn query_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The OS version, for the results table.
///
/// This exists because **a webview's user-agent cannot be trusted to identify anything**: WKWebView
/// reports a frozen UA (`Intel Mac OS X 10_15_7`, no Safari token) regardless of the real system, so
/// a result row labelled only by UA string names the engine family and nothing more. Shelling out is
/// the no-dependency way to get the truth, and a spike may shell out.
fn os_version() -> String {
    let output = if cfg!(target_os = "macos") {
        std::process::Command::new("sw_vers").arg("-productVersion").output()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd").args(["/c", "ver"]).output()
    } else {
        // /etc/os-release's PRETTY_NAME is the distro identity, which for the old-LTS Linux row is
        // the whole point of the row.
        if let Ok(release) = std::fs::read_to_string("/etc/os-release") {
            let pretty = release
                .lines()
                .find_map(|l| l.strip_prefix("PRETTY_NAME="))
                .map(|v| v.trim_matches('"').to_string());
            if let Some(pretty) = pretty {
                return pretty;
            }
        }
        std::process::Command::new("uname").arg("-sr").output()
    };

    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if text.is_empty() {
                std::env::consts::OS.to_string()
            } else {
                format!("{} {}", std::env::consts::OS, text)
            }
        }
        _ => std::env::consts::OS.to_string(),
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "webm" => "video/webm",
        "apng" | "png" => "image/png",
        "opus" | "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// Every response carries permissive CORS. The `scheme` mode's page lives on `tauri://localhost`
/// and still needs to reach `POST /save`, which is cross-origin from there. Acceptable because
/// this listener is bound to loopback and exists only while the spike is open; it is exactly the
/// kind of thing that must not be copied into the node.
fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

/// Resolve a request path inside `root`, refusing anything that escapes it. Canonicalize-then-
/// prefix-check rather than string inspection: `..` is not the only way out of a directory, and
/// symlinks are the way people forget.
fn resolve_within(root: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = request_path.trim_start_matches('/');
    let relative = if relative.is_empty() { "index.html" } else { relative };
    let candidate = root.join(relative).canonicalize().ok()?;
    if candidate.starts_with(root) && candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn handle(mut stream: TcpStream, root: &Path, out_dir: &Path) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let (method, target) = match (parts.next(), parts.next()) {
        (Some(m), Some(t)) => (m.to_string(), t.to_string()),
        _ => return,
    };

    // Headers, to the blank line. Only Content-Length matters here.
    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.trim().is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
                }
            }
            Err(_) => return,
        }
    }

    let path = target.split('?').next().unwrap_or("/").to_string();

    match method.as_str() {
        // Preflight for the save POST from the custom-scheme origin.
        "OPTIONS" => respond(&mut stream, "204 No Content", "text/plain", b""),

        "GET" => match resolve_within(root, &path) {
            Some(file) => match std::fs::read(&file) {
                Ok(bytes) => respond(&mut stream, "200 OK", mime_for(&file), &bytes),
                Err(e) => respond(
                    &mut stream,
                    "500 Internal Server Error",
                    "text/plain; charset=utf-8",
                    format!("read failed: {e}").as_bytes(),
                ),
            },
            None => respond(
                &mut stream,
                "404 Not Found",
                "text/plain; charset=utf-8",
                b"not found",
            ),
        },

        "POST" if path.starts_with("/save/") => {
            // The filename is ours to sanitize: take the last segment and keep only characters
            // that cannot walk anywhere.
            let raw = path.trim_start_matches("/save/");
            let name: String = raw
                .rsplit('/')
                .next()
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
                .collect();
            if name.is_empty() || name.starts_with('.') {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain; charset=utf-8",
                    b"bad filename",
                );
                return;
            }

            let length: usize = headers
                .get("content-length")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            if length > MAX_SAVE_BYTES {
                respond(
                    &mut stream,
                    "413 Payload Too Large",
                    "text/plain; charset=utf-8",
                    b"too large",
                );
                return;
            }

            let mut body = vec![0u8; length];
            if reader.read_exact(&mut body).is_err() {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain; charset=utf-8",
                    b"short body",
                );
                return;
            }

            let _ = std::fs::create_dir_all(out_dir);
            let target_path = out_dir.join(&name);
            match std::fs::write(&target_path, &body) {
                Ok(()) => {
                    println!("saved {} ({} bytes)", target_path.display(), body.len());
                    respond(
                        &mut stream,
                        "200 OK",
                        "text/plain; charset=utf-8",
                        target_path.display().to_string().as_bytes(),
                    )
                }
                Err(e) => respond(
                    &mut stream,
                    "500 Internal Server Error",
                    "text/plain; charset=utf-8",
                    format!("write failed: {e}").as_bytes(),
                ),
            }
        }

        _ => respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"method not allowed",
        ),
    }
}

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let ui_root = manifest
        .join("../ui")
        .canonicalize()
        .expect("spike-tauri/ui must exist beside src-tauri");
    let out_dir = manifest.join("../out");

    if !ui_root.join("vendor/dexie.mjs").is_file() {
        eprintln!(
            "warning: ui/vendor is missing or incomplete - run ./sync-vendor.sh first, or the \
             probes will fail to import Dexie and video-ingest"
        );
    }

    let listener = TcpListener::bind("127.0.0.1:0").expect("binding loopback");
    let port = listener.local_addr().expect("local addr").port();

    {
        let ui_root = ui_root.clone();
        let out_dir = out_dir.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let ui_root = ui_root.clone();
                let out_dir = out_dir.clone();
                thread::spawn(move || handle(stream, &ui_root, &out_dir));
            }
        });
    }

    // `scheme` exercises DESKTOP.md's stable-origin trick; `http` exercises the shape where the
    // node serves the UI. Anything unrecognized falls to `http` - the faithful default.
    let mode = std::env::var("SPIKE_ORIGIN").unwrap_or_else(|_| "http".to_string());
    let scheme_mode = mode == "scheme";

    // The engine version, from the runtime rather than from the UA string - this is the fact that
    // makes a results row interpretable six months later.
    let webview = tauri::webview_version().unwrap_or_else(|e| format!("unknown ({e})"));
    let os = os_version();

    println!("spike-tauri: origin mode = {mode}, save endpoint = http://127.0.0.1:{port}/save/");
    println!("spike-tauri: webview = {webview}, os = {os}");
    if !scheme_mode {
        println!("spike-tauri: serving probe page at http://127.0.0.1:{port}/index.html");
    }

    let facts = format!(
        "port={port}&webview={}&os={}",
        query_encode(&webview),
        query_encode(&os)
    );

    tauri::Builder::default()
        .setup(move |app| {
            // The port and mode ride in the query string in BOTH modes, so the page can reach
            // the save endpoint from the custom scheme without any IPC surface at all.
            let url = if scheme_mode {
                WebviewUrl::App(format!("index.html?{facts}&origin=scheme").into())
            } else {
                WebviewUrl::External(
                    format!("http://127.0.0.1:{port}/index.html?{facts}&origin=http")
                        .parse()
                        .expect("probe url"),
                )
            };

            let window = WebviewWindowBuilder::new(app, "probe", url)
                .title("ringtome — Tauri spike (IndexedDB + video encode)")
                .inner_size(1180.0, 900.0)
                .build()?;

            #[cfg(debug_assertions)]
            window.open_devtools();
            let _ = &window;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("running the spike harness");
}
