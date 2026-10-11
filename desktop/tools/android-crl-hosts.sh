#!/usr/bin/env bash
# The certificate authorities' revocation-list hosts, in the app's network security config
# (gen/android/app/src/main/res/xml/network_security_config.xml), as the certificate verifier's
# Kotlin half lists them for its own (2026-10-10).
#
# Since 0.2.0 of `rustls-platform-verifier-android`, the verifier checks a certificate against its
# CA's revocation list, fetched over plain http, and its .aar ships a network security config
# permitting cleartext to exactly those hosts. An app has one such config, and ours - cleartext to
# the node at 127.0.0.1 - shares its resource name, so ours replaces the library's whole and the
# list never reaches the phone: every certificate would be "revoked" again. So the list is carried
# in ours, between the markers, and this refreshes it from the .aar of the version desktop/Cargo.lock
# holds. Run from desktop/ after updating rustls-platform-verifier; `--check` only says whether the
# committed list is that version's.
set -euo pipefail

config=gen/android/app/src/main/res/xml/network_security_config.xml
begin='<!-- revocation-list hosts: begin -->'
end='<!-- revocation-list hosts: end -->'

version=$(awk '/^name = "rustls-platform-verifier-android"$/ { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)
[ -n "$version" ] || { echo "::error::rustls-platform-verifier-android is not in desktop/Cargo.lock"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -sSfL -o "$work/v.aar" \
    "https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/org/rustls/rustls-platform-verifier/$version/rustls-platform-verifier-$version.aar"
unzip -q -o "$work/v.aar" res/xml/network_security_config.xml -d "$work"

# The library's cleartext domains, as ours writes them.
{
    echo "    $begin"
    echo "    <!-- rustls-platform-verifier-android $version, by desktop/tools/android-crl-hosts.sh -->"
    echo '    <domain-config cleartextTrafficPermitted="true">'
    grep -o '<domain [^>]*>[^<]*</domain>' "$work/res/xml/network_security_config.xml" | sed 's/^/        /'
    echo '    </domain-config>'
    echo "    $end"
} > "$work/hosts"

# Ours, the section between the markers replaced (or added before the config's end).
awk -v begin="$begin" -v end="$end" -v hosts="$work/hosts" '
    function emit() { while ((getline line < hosts) > 0) print line; done = 1 }
    index($0, begin) { skip = 1; next }
    index($0, end) { skip = 0; emit(); next }
    skip { next }
    /<\/network-security-config>/ && !done { emit() }
    { print }
' "$config" > "$work/config"

if [ "${1:-}" = "--check" ]; then
    if ! cmp -s "$config" "$work/config"; then
        echo "::error::$config's revocation-list hosts aren't rustls-platform-verifier-android $version's: run desktop/tools/android-crl-hosts.sh"
        exit 1
    fi
    echo "the revocation-list hosts are rustls-platform-verifier-android $version's"
else
    cp "$work/config" "$config"
    echo "wrote rustls-platform-verifier-android $version's revocation-list hosts into $config"
fi
