// Harness orchestration: wire the buttons, render rows, and emit a Markdown block that can be
// pasted into README's results table.
//
// The Markdown export is the point of the whole harness. A spike that leaves its findings in a
// scrolled-past console answers nothing six weeks later - the deliverable is a row in a table
// that says which engine, which origin mode, and what happened.

import { runIndexedDbProbe, forgetProbeDatabase } from './probe-indexeddb.js';
import { runCapabilityProbe, runIngestLane, generateFixture } from './probe-video.js';

const params = new URLSearchParams(location.search);
const port = params.get('port');
const originMode = params.get('origin') ?? (location.protocol === 'http:' ? 'http' : 'scheme');
// Handed down by the harness, because the webview's UA identifies nothing: WKWebView reports a
// frozen `Intel Mac OS X 10_15_7` no matter the real system. `tauri::webview_version()` is the
// engine's actual version and is the fact that makes a results row worth keeping.
const webviewVersion = params.get('webview') ?? 'unknown (harness did not supply it)';
const osVersion = params.get('os') ?? 'unknown (harness did not supply it)';

const state = {
    env: {},
    idb: null,
    caps: null,
    ingests: [],
    file: null,
    vendored: null,
};

const $ = (id) => document.getElementById(id);

function badge(ok) {
    return ok ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>';
}

// An informational row describes the engine and cannot fail the run, so it must not be painted
// like a failure - a red FAIL beside "ImageDecoder absent (harmless)" invites exactly the wrong
// conclusion, which is the mistake that produced a bogus Linux FAIL verdict on 2026-08-11.
function rowBadge(row) {
    if (row.informational) return `<span class="info">${row.ok ? 'note' : 'n/a'}</span>`;
    return badge(row.ok);
}

function renderRows(tableId, rows, withMs) {
    const table = $(tableId);
    const body = table.querySelector('tbody');
    body.innerHTML = rows
        .map(
            (r) =>
                `<tr><td class="state">${rowBadge(r)}</td><td>${escapeHtml(r.name)}</td>` +
                `<td class="detail">${escapeHtml(r.detail ?? '')}</td>` +
                (withMs ? `<td class="ms">${r.ms ?? ''}</td>` : '') +
                `</tr>`,
        )
        .join('');
    table.hidden = rows.length === 0;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function collectEnv() {
    let vendored = null;
    try {
        vendored = await (await fetch('./vendor/VENDORED.json')).json();
    } catch {
        vendored = { note: 'vendor/VENDORED.json unreadable — did sync-vendor.sh run?' };
    }
    state.vendored = vendored;
    state.env = {
        originMode,
        origin: location.origin,
        webviewVersion,
        osVersion,
        isSecureContext: globalThis.isSecureContext,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        userAgent: `${navigator.userAgent}  (NOT a version: webviews freeze this)`,
        platform: navigator.platform,
        deviceMemoryGB: navigator.deviceMemory ?? 'unknown',
        hardwareConcurrency: navigator.hardwareConcurrency ?? 'unknown',
        savePort: port ?? 'unknown',
        dexie: vendored?.dexie_version ?? 'unknown',
        videoIngestCommit: vendored?.video_ingest_commit ?? 'unknown',
    };
    $('env').textContent = Object.entries(state.env)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
}

$('run-idb').addEventListener('click', async () => {
    const button = $('run-idb');
    button.disabled = true;
    $('idb-verdict').textContent = 'running…';
    const rows = [];
    try {
        const result = await runIndexedDbProbe({
            onStep: (r) => {
                rows.push(r);
                renderRows('idb-table', rows, true);
            },
        });
        state.idb = result;
        $('idb-verdict').innerHTML = `${badge(result.verdict.startsWith('PASS'))} ${escapeHtml(result.verdict)} — ${escapeHtml(result.summary)}`;
    } catch (err) {
        $('idb-verdict').innerHTML = `${badge(false)} probe crashed: ${escapeHtml(err?.message ?? err)}`;
    } finally {
        button.disabled = false;
    }
});

$('reload').addEventListener('click', () => location.reload());

$('forget').addEventListener('click', async () => {
    try {
        $('idb-verdict').textContent = await forgetProbeDatabase();
        state.idb = null;
    } catch (err) {
        $('idb-verdict').textContent = `delete failed: ${err?.message ?? err}`;
    }
});

function enableIngestButtons() {
    const ready = Boolean(state.file);
    for (const id of ['run-auto', 'run-av1', 'run-frames']) $(id).disabled = !ready;
}

$('run-caps').addEventListener('click', async () => {
    $('video-verdict').textContent = 'probing…';
    try {
        const result = await runCapabilityProbe();
        state.caps = result;
        renderRows('caps-table', result.rows, false);

        // The distinction the whole probe exists to draw. AudioEncoder is needed by both lanes,
        // and playback decode is needed before anything can be laundered at all.
        const audio = result.rows.find((r) => r.name === 'AudioEncoder Opus');
        const canDecodeAnything = result.rows.some(
            (r) => r.name.startsWith('<video> can play') && r.ok,
        );
        let verdict;
        if (!canDecodeAnything) {
            verdict = `${badge(false)} BLOCKING — this webview reports it can play nothing; there is no hostile decode to launder with`;
        } else if (!audio?.ok) {
            verdict = `${badge(false)} BLOCKING — no AudioEncoder, so neither lane can emit Opus (workaround: upload raw PCM, encode server-side)`;
        } else if (result.lane === 'av1') {
            verdict = `${badge(true)} happy path available — pickLane() routes to <code>av1</code>`;
        } else {
            verdict = `${badge(true)} DEGRADED but workable — no MediaRecorder AV1, so pickLane() routes to <code>frames</code> (bandwidth-heavy fallback)`;
        }
        $('video-verdict').innerHTML = verdict;
    } catch (err) {
        $('video-verdict').innerHTML = `${badge(false)} capability probe crashed: ${escapeHtml(err?.message ?? err)}`;
    }
});

$('file').addEventListener('change', (e) => {
    const file = e.target.files?.[0] ?? null;
    state.file = file;
    if (file) {
        $('video-verdict').innerHTML = `file: ${escapeHtml(file.name)} (${(file.size / 1024 / 1024).toFixed(1)}MB, ${escapeHtml(file.type || 'type unknown')})`;
    }
    enableIngestButtons();
});

$('gen').addEventListener('click', async () => {
    const button = $('gen');
    button.disabled = true;
    $('video-verdict').textContent = 'generating a 4s fixture…';
    try {
        state.file = await generateFixture({ seconds: 4 });
        $('video-verdict').innerHTML = `generated fixture: ${(state.file.size / 1024).toFixed(0)}KB ${escapeHtml(state.file.type)}`;
    } catch (err) {
        // Reported distinctly: a fixture failure is NOT an ingest failure.
        $('video-verdict').innerHTML = `${badge(false)} could not generate a fixture (${escapeHtml(err?.message ?? err)}) — this is a MediaRecorder limitation, not an ingest result. Pick a real file.`;
    } finally {
        button.disabled = false;
        enableIngestButtons();
    }
});

async function ingest(lane, label) {
    if (!state.file) return;
    const rows = state.ingests;
    $('video-verdict').textContent = `ingesting (${label})… this can take a while; the av1 lane records at playback speed`;
    try {
        const result = await runIngestLane({
            file: state.file,
            lane,
            port,
            save: $('save').checked,
        });
        rows.push({
            ok: true,
            name: `${label} → ${result.lane}`,
            detail: `${result.facts.join(' · ')} · ${result.decode}${result.saved.length ? ` · saved: ${result.saved.join(', ')}` : ''}`,
            ms: result.ms,
        });
        $('video-verdict').innerHTML = `${badge(true)} ${escapeHtml(label)} completed and its output re-decoded here`;
    } catch (err) {
        rows.push({
            ok: false,
            name: `${label} → failed`,
            detail: `${err?.name ?? 'Error'}: ${err?.message ?? err}`,
            ms: null,
        });
        $('video-verdict').innerHTML = `${badge(false)} ${escapeHtml(label)} failed: ${escapeHtml(err?.message ?? err)}`;
    }
    renderRows('ingest-table', rows, true);
}

$('run-auto').addEventListener('click', () => ingest(undefined, 'routed lane'));
$('run-av1').addEventListener('click', () => ingest('av1', 'forced av1'));
$('run-frames').addEventListener('click', () => ingest('frames', 'forced frames'));

function markdown() {
    const lines = [];
    lines.push(`### ${osVersion} — origin mode \`${originMode}\``);
    lines.push('');
    lines.push(`- **Webview:** \`${webviewVersion}\` (from the runtime, not the UA)`);
    lines.push(`- **OS:** \`${osVersion}\``);
    lines.push(`- **Origin:** \`${state.env.origin}\` · secureContext=${state.env.isSecureContext} · crossOriginIsolated=${state.env.crossOriginIsolated}`);
    lines.push(`- **Tested:** Dexie ${state.env.dexie}, video-ingest \`${state.env.videoIngestCommit}\``);
    lines.push(`- **UA (identifies nothing, kept for completeness):** \`${navigator.userAgent}\``);
    lines.push('');

    lines.push('**IndexedDB / the mirror**');
    lines.push('');
    if (!state.idb) {
        lines.push('_not run_');
    } else {
        lines.push(`Verdict: **${state.idb.verdict}** — ${state.idb.summary}`);
        lines.push('');
        lines.push('| | Step | Detail | ms |');
        lines.push('|---|---|---|---|');
        for (const r of state.idb.results) {
            const mark = r.informational ? (r.ok ? 'note' : 'n/a') : r.ok ? 'PASS' : 'FAIL';
            lines.push(`| ${mark} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|')} | ${r.ms} |`);
        }
    }
    lines.push('');

    lines.push('**Video encode**');
    lines.push('');
    if (!state.caps) {
        lines.push('_capability probe not run_');
    } else {
        lines.push(`Routed lane: \`${state.caps.lane}\``);
        lines.push('');
        lines.push('| | Capability | Detail |');
        lines.push('|---|---|---|');
        for (const r of state.caps.rows) {
            lines.push(`| ${r.ok ? 'yes' : 'no'} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|')} |`);
        }
    }
    lines.push('');
    if (state.ingests.length) {
        lines.push('| | Run | Result | ms |');
        lines.push('|---|---|---|---|');
        for (const r of state.ingests) {
            lines.push(`| ${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|')} | ${r.ms ?? ''} |`);
        }
    } else {
        lines.push('_no end-to-end ingest run_');
    }

    return lines.join('\n');
}

$('export').addEventListener('click', () => {
    $('markdown').value = markdown();
    $('markdown').select();
});

collectEnv();
