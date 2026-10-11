#!/usr/bin/env bash
# The Android project is committed (desktop/gen/android, since 2026-10-08): generated once from
# Tauri's template by CI (.github/workflows/android.yml, run by hand with `project=true`) and edited
# like any other source from then on. This only checks that it still carries what the app can't
# run without, so a template refresh that drops one fails the build rather than the phone:
#
# - the network security config: cleartext http to the node at 127.0.0.1, and to the certificate
#   authorities' revocation lists (tools/android-crl-hosts.sh), and nowhere else;
# - the certificate verifier's Kotlin half (src/android_tls.rs), and the shrinker rule keeping it.
#
# Run from desktop/.
set -euo pipefail

app=gen/android/app
fail=0
need() { # file, fixed string, what it is
    if ! grep -qF -- "$2" "$1" 2>/dev/null; then
        echo "::error::$1 lacks $3"
        fail=1
    fi
}
[ -d gen/android ] || { echo "::error::no desktop/gen/android - it is committed; see this script's header"; exit 1; }
need "$app/src/main/AndroidManifest.xml" 'android:networkSecurityConfig="@xml/network_security_config"' "the network security config"
need "$app/src/main/res/xml/network_security_config.xml" '<domain includeSubdomains="false">127.0.0.1</domain>' "cleartext to 127.0.0.1"
need "$app/build.gradle.kts" 'implementation("org.rustls:rustls-platform-verifier:$rustlsPlatformVerifierVersion@aar")' "the certificate verifier's Kotlin half"
need "$app/src/main/res/xml/network_security_config.xml" '<!-- revocation-list hosts: begin -->' "the revocation-list hosts"
need "$app/proguard-rules.pro" 'class org.rustls.platformverifier.**' "the shrinker rule keeping the certificate verifier"
[ "$fail" -eq 0 ] || exit 1
tools/android-crl-hosts.sh --check
echo "gen/android carries the network security config and the certificate verifier"
