### Ubuntu 26.04 LTS — origin mode `http`

- **Webview:** `2.52.3` (from the runtime, not the UA)
- **OS:** `Ubuntu 26.04 LTS`
- **Origin:** `http://127.0.0.1:39315` · secureContext=true · crossOriginIsolated=false
- **Tested:** Dexie 4.4.4, video-ingest `ad9dbd5`
- **UA (identifies nothing, kept for completeness):** `Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15`

**IndexedDB / the mirror**

Verdict: **FAIL** — 1 failing: storage quota + persistence posture

| | Step | Detail | ms |
|---|---|---|---|
| PASS | IndexedDB present | Dexie 4.4.4 | 0 |
| PASS | open + declare schema | 10 stores | 75 |
| PASS | persistence across reload | no marker yet — press "Reload window" and re-run to test this | 5 |
| PASS | snapshot apply (clear+bulkPut, one rw txn, 7 stores) | 2000 docs + 2000 search rows | 148 |
| PASS | delta apply (50 rounds of bulkPut + bulkDelete) | 1950 docs remain | 181 |
| PASS | liveQuery fires on write | 2 emissions, reacted to the write | 63 |
| PASS | Blob round-trip (8MB, doccache shape) | Blob stored and read back byte-identical | 272 |
| PASS | ArrayBuffer round-trip (same size) | ArrayBuffer stored and read back byte-identical | 178 |
| FAIL | storage quota + persistence posture | Error: navigator.storage is undefined | 0 |
| PASS | write reload marker | marker at 1951 docs — reload and re-run to prove persistence | 9 |

**Video encode**

Routed lane: `av1`

| | Capability | Detail |
|---|---|---|
| yes | secure context | isSecureContext=true, origin=http://127.0.0.1:39315, crossOriginIsolated=false |
| yes | MediaRecorder | present |
| yes | WebCodecs VideoEncoder | present |
| yes | WebCodecs VideoDecoder | present |
| yes | WebCodecs AudioDecoder | present |
| yes | OffscreenCanvas | present |
| no | HTMLMediaElement.captureStream (av1 lane audio tap) | absent |
| yes | canvas.toBlob (frames lane) | present |
| yes | AudioContext.decodeAudioData (frames lane audio) | present |
| no | ImageDecoder (informational — test-only in video-ingest) | absent (Chromium-only; harmless) |
| no | SharedArrayBuffer (informational — gates a wasm-codec workaround) | absent — a wasm encoder fallback would need COOP/COEP |
| yes | <video> can play H.264 in MP4 | probably |
| yes | <video> can play HEVC in MP4 | probably |
| yes | <video> can play AAC in MP4 | probably |
| yes | <video> can play VP9 in WebM | probably |
| yes | <video> can play AV1 in WebM | probably |
| yes | <video> can play Opus in WebM | probably |
| yes | <video> can play Opus in Ogg | probably |
| yes | MediaRecorder WebM AV1+Opus | video/webm;codecs=av01,opus |
| yes | MediaRecorder WebM AV1 | video/webm;codecs=av01 |
| yes | MediaRecorder WebM VP9+Opus | video/webm;codecs=vp9,opus |
| yes | MediaRecorder WebM VP8+Opus | video/webm;codecs=vp8,opus |
| yes | MediaRecorder MP4 H.264 | video/mp4;codecs=avc1.42001E |
| yes | VideoEncoder AV1 | av01.0.04M.08 |
| yes | VideoEncoder VP9 | vp09.00.10.08 |
| yes | VideoEncoder VP8 | vp8 |
| yes | VideoEncoder H.264 | avc1.42001E |
| yes | VideoDecoder AV1 | av01.0.04M.08 |
| yes | VideoDecoder VP9 | vp09.00.10.08 |
| yes | VideoDecoder VP8 | vp8 |
| yes | VideoDecoder H.264 | avc1.42001E |
| yes | AudioEncoder Opus | opus |
| yes | video-ingest pickLane() — the library's own routing | av1 (happy path) |
| yes | av1RecorderMimeType() | video/webm;codecs=av01,opus |

_no end-to-end ingest run_
