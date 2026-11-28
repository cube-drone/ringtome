#!/usr/bin/env bash
# The App Store's screenshots, from a simulator (.github/workflows/ios.yml's `sim`; 2026-11-28).
# Nobody here has an iPhone or an iPad, and Apple takes simulator screenshots as long as they
# show the app. One device per call, by its exact simulator name:
#
#   desktop/tools/ios-store-shots.sh "iPhone 17 Pro Max" out/store/iphone path/to/App.app
#
# The device is booted fresh, the debug build installed, and its node filled by the test data
# generator (node/harness/testdata.mjs) through the port it wrote down - the simulator shares
# the runner's network. Then, once per page, the app is opened signed in as the generator's first
# persona and sent to that page (desktop/src/lib.rs `test_sign_in`, debug builds only), and the
# screen is kept. The status bar reads 9:41 with full bars, as Apple's own pictures do.
#
# Run from the repository's root. Each page's screenshot is named for its order and its path.
set -euo pipefail

name="$1"
out="$2"
app="$3"
bundle="net.lassam.ringtome"
# A fixed seed, so a run's screenshots show the same network as the last run's.
seed="20261128"
pages=(/feed /ringtome/chat /ringtome/people /ringtome/games /ringtome/bank)

udid=$(xcrun simctl list devices available -j | NAME="$name" python3 -c "
import json, os, sys
want = os.environ['NAME']
runtimes = json.load(sys.stdin)['devices']
found = [(runtime, d) for runtime, ds in runtimes.items() if 'iOS' in runtime for d in ds if d['name'] == want]
found.sort(key=lambda p: [int(n) for n in p[0].rsplit('iOS-', 1)[-1].split('-') if n.isdigit()])
if not found:
    sys.exit('no simulator named ' + want)
runtime, device = found[-1]
print(device['udid'])
print(want, 'on', runtime, file=sys.stderr)
")
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl status_bar "$udid" override --time "9:41" --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 --wifiBars 3 || true
xcrun simctl install "$udid" "$app"
xcrun simctl launch "$udid" "$bundle" >/dev/null

port=""
for _ in $(seq 1 90); do
    data=$(xcrun simctl get_app_container "$udid" "$bundle" data 2>/dev/null || true)
    file=$(find "$data" -name desktop-port 2>/dev/null | head -1 || true)
    if [ -n "$file" ] && curl -sf -m 2 "http://127.0.0.1:$(cat "$file")/health" >/dev/null; then
        port=$(cat "$file")
        break
    fi
    sleep 2
done
[ -n "$port" ] || { echo "::error::$name: the node never answered"; exit 1; }
echo "$name: the node is on $port"

state="node/harness/testdata-state.json"
rm -f "$state"
(cd node/harness && RINGTOME_TESTDATA_PORTS="$port" node testdata.mjs 6 12 "$seed")
user=$(python3 -c "import json; print(json.load(open('$state'))['personas'][0]['username'])")
pass=$(python3 -c "import json; print(json.load(open('$state'))['password'])")
root=$(python3 -c "import json; print(json.load(open('$state'))['personas'][0]['root'])")
echo "$name: signed in as $user"

# The apps a new persona buys with HorseBucks (the hrseBank market) - chat, people, the feed - are
# what the screenshots are of. The generator's first persona is the node's administrator, and an
# administrator may unlock everything at once (bank.rs `unlock_everything`).
jar=$(mktemp)
curl -sf -c "$jar" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$pass\"}" "http://127.0.0.1:$port/api/auth/login" >/dev/null
curl -sf -b "$jar" -H 'Content-Type: application/json' -d '{"id":"everything"}' \
    "http://127.0.0.1:$port/api/identity/$root/bank/unlocks" >/dev/null \
    || echo "::warning::$name: couldn't unlock everything for $user"
rm -f "$jar"

mkdir -p "$out"
n=0
for page in "${pages[@]}"; do
    n=$((n + 1))
    xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
    SIMCTL_CHILD_RINGTOME_TEST_SIGN_IN="$user:$pass" SIMCTL_CHILD_RINGTOME_TEST_PAGE="$page" \
        xcrun simctl launch "$udid" "$bundle" >/dev/null
    # The node's boot, the sign-in, the page and its pictures.
    sleep 25
    shot="$out/$n$(echo "$page" | tr '/' '-').png"
    xcrun simctl io "$udid" screenshot "$shot"
    echo "$name: $shot"
done
xcrun simctl shutdown "$udid" || true
