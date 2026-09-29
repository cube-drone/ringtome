// The app's own pictures (Curtis, 2026-09-29): every file under the repository's
// `default_media/` is compiled into the node, file after file, and every persona sees them in
// their files, tagged by the folders they sit in. Add a file and rebuild: everyone has it.
// Remove one and rebuild: it's gone. `src/builtin.rs` reads the table this writes.

use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let root = manifest.join("../default_media");
    // A directory here is scanned whole by cargo: an added, removed or changed file reruns this.
    println!("cargo:rerun-if-changed={}", root.display());

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    if root.is_dir() {
        walk(&root, &root, &mut files);
    }
    files.sort();

    let mut out = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for (rel, abs) in &files {
        out.push_str(&format!("    ({rel:?}, include_bytes!({:?})),\n", abs.display().to_string()));
    }
    out.push_str("];\n");
    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("default_media.rs");
    std::fs::write(dest, out).expect("writing the default media table");
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // .DS_Store and friends
        }
        if path.is_dir() {
            walk(root, &path, out);
            continue;
        }
        // Pictures only, and only the one kind every browser draws unaided: a PNG (a still, or an
        // animated APNG) is served to the page exactly as it sits in the folder.
        if !name.to_ascii_lowercase().ends_with(".png") {
            println!("cargo:warning=default_media: {} is not a PNG - left out", path.display());
            continue;
        }
        let rel = path.strip_prefix(root).expect("walked from the root").to_string_lossy().replace('\\', "/");
        let abs = path.canonicalize().unwrap_or(path);
        out.push((rel, abs));
    }
}
