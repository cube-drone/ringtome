#!/usr/bin/env bash
# The Android project Tauri generates (`tauri android init` -> gen/android), and the one change it
# needs from us: the window loads the node at http://127.0.0.1:<port> (src/lib.rs), and Android
# refuses cleartext http by default. A network security config lets it through for the loopback
# address and nothing else - not the template's all-or-nothing `usesCleartextTraffic`.
#
# Idempotent: generates the project only when it is absent (once it is committed, this only
# checks), writes the config, and wires it into the manifest once. Run from desktop/, in CI
# (.github/workflows/android.yml) and by hand before committing gen/android.
set -euo pipefail

# Through `npm run tauri` (desktop/package.json, the CLI pinned), never `npx`: the generated project
# remembers how init was run and calls the CLI back the same way from Gradle - after an `npx` init
# that was `npm run tauri` with no package.json to run it from (field-found, the first CI run).
if [ ! -d gen/android ]; then
    npm run tauri -- android init --ci
fi

xml=gen/android/app/src/main/res/xml/network_security_config.xml
mkdir -p "$(dirname "$xml")"
cat > "$xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<!-- desktop/tools/android-project.sh: plain http to the node inside the app, and nowhere else. -->
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
XML

manifest=gen/android/app/src/main/AndroidManifest.xml
if ! grep -q 'android:networkSecurityConfig=' "$manifest"; then
    sed -i.bak 's|<application|<application android:networkSecurityConfig="@xml/network_security_config"|' "$manifest"
    rm -f "$manifest.bak"
fi
# Said, not assumed: a template that renamed its tag would leave the app unable to reach its node,
# and that failure is a blank window on a phone - worth a red build instead.
grep -q 'android:networkSecurityConfig="@xml/network_security_config"' "$manifest" || {
    echo "::error::could not wire the network security config into $manifest"
    exit 1
}
# The certificate verifier's Kotlin half (src/android_tls.rs): rustls-platform-verifier calls into
# `org.rustls.platformverifier`, shipped as an .aar inside the `rustls-platform-verifier-android`
# crate rather than on Maven - so the crate's own copy is the repository. Its path is this
# machine's cargo registry, which is right while CI generates the project per build; a committed
# gen/android has to find it at Gradle time instead (the crate's README has that snippet).
gradle=gen/android/app/build.gradle.kts
if ! grep -q 'rustls-platform-verifier' "$gradle"; then
    maven=$(cargo metadata --format-version 1 --filter-platform aarch64-linux-android --manifest-path Cargo.toml |
        python3 -c 'import json,os,sys; d=json.load(sys.stdin); m=[p["manifest_path"] for p in d["packages"] if p["name"]=="rustls-platform-verifier-android"]; print(os.path.join(os.path.dirname(m[0]),"maven")) if m else sys.exit("rustls-platform-verifier-android is not in the Android dependency graph")')
    cat >> "$gradle" <<GRADLE

// desktop/tools/android-project.sh: the certificate verifier's Kotlin half (src/android_tls.rs).
repositories {
    maven {
        url = uri("$maven")
        metadataSources { artifact() }
    }
}
dependencies {
    implementation("rustls:rustls-platform-verifier:latest.release")
}
GRADLE
fi
# Reached only through JNI, which the release build's shrinker can't see: kept by name. Tauri's
# template gives the shrinker every .pro file in the app directory.
cat > gen/android/app/rustls-platform-verifier.pro <<'PRO'
# desktop/tools/android-project.sh: called from Rust over JNI, invisible to the shrinker.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
PRO
grep -q 'rustls-platform-verifier' "$gradle" || {
    echo "::error::could not add the certificate verifier to $gradle"
    exit 1
}

echo "gen/android ready: cleartext to 127.0.0.1 only, the certificate verifier added"
