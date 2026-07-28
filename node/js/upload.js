// File upload, phase two: the machinery behind the modal. Each captured File uploads to
// `POST /docs/binary` (raw bytes, title in the query; XHR because fetch has no upload
// progress), lands a `202 { doc_id, job_id }` - the doc exists version-less, quarantined for
// AVIF transcode - and then the modal follows the job through the server's ingest queue
// (`GET /ingest`, polled) to done or failed. While all that happens the file's NAME is
// editable (a PATCH on the queued job - the title is baked into the version at transcode, so
// the server reports honestly when a rename arrives too late) and its TAGS are editable
// immediately (annotations live on the doc-meta chain, version-independent). New docs file
// into the CURRENT bucket the moment their id exists. Phase three adds the in-document
// placeholder and the final file reference.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { Modal, fmtBytes } from './modal.js';
import { Annotations } from './annotations.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body.message || `request failed (${res.status})`);
    }
    return body;
}

// The one job fetch() can't do: report upload progress. Resolves with the 202's JSON.
function uploadBinary(root, file, title, onPct) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/identity/${root}/docs/binary?title=${encodeURIComponent(title)}`);
        xhr.responseType = 'json';
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
            else {
                reject(
                    new Error(
                        (xhr.response && xhr.response.message) || `upload failed (${xhr.status})`
                    )
                );
            }
        };
        xhr.onerror = () => reject(new Error('upload failed (network)'));
        xhr.send(file);
    });
}

const QUEUE_WORD = {
    pending: 'waiting in the processing queue…',
    processing: 'processing…',
};

export const UploadFlow = ({ root, bucket, files, onClose }) => {
    // One row per file. `phase`: uploading -> queued -> done | failed.
    const [rows, setRows] = useState(() =>
        files.map((f) => ({
            file: f,
            name: f.name,
            pct: 0,
            docId: null,
            jobId: null,
            phase: 'uploading',
            queueStatus: 'pending',
            error: null,
            // The name the server currently holds for this file. A rename is "pending" whenever
            // the input differs from this; it applies wherever the file is in its life - the
            // queued job while pending, the DOCUMENT record once a version exists.
            appliedName: f.name,
            tagsOpen: false,
        }))
    );
    const patchRow = (i, up) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...up } : r)));
    // The names as they are RIGHT NOW (state is async; async completions need current values).
    const namesRef = useRef(files.map((f) => f.name));

    // Apply the row's current name wherever the file is: the queued job (title lands at
    // transcode) or, once processed, the document record itself (the media-safe retitle route).
    // A rename that finds the job already claimed simply waits - the poll applies it on done.
    const renameNow = async (i, row) => {
        const title = namesRef.current[i];
        if (!title || title === row.appliedName) return;
        try {
            if (row.phase === 'done' && row.docId) {
                await api(`/api/identity/${root}/docs/${row.docId}/title`, {
                    method: 'PATCH',
                    body: JSON.stringify({ title }),
                });
                patchRow(i, { appliedName: title });
            } else if (row.jobId) {
                const res = await api(`/api/identity/${root}/ingest/${row.jobId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ title }),
                });
                if (res.applied) patchRow(i, { appliedName: title });
                // Not applied: the worker already claimed it - the done-transition below
                // retitles the finished document instead. Nothing is lost.
            }
        } catch {
            /* transient; the next blur (or the done transition) retries */
        }
    };

    // What the browser can honestly send: the crush pipeline speaks images, audio, and a few
    // video codecs. Anything else (a PDF, a zip) bounces HERE, kindly, before a byte moves -
    // not at the far end of a full upload.
    const accepted = (file) =>
        /^(image|audio|video)\//.test(file.type || '') ||
        // Some platforms hand over files with no type at all; let the server judge those.
        !file.type;

    // Fire every upload once, on mount.
    const started = useRef(false);
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        files.forEach(async (file, i) => {
            if (!accepted(file)) {
                patchRow(i, {
                    phase: 'failed',
                    error: `Ringtome can't store this kind of file yet - images, audio, and some video (this is ${file.type}).`,
                });
                return;
            }
            try {
                const res = await uploadBinary(root, file, namesRef.current[i], (pct) =>
                    patchRow(i, { pct })
                );
                patchRow(i, { docId: res.doc_id, jobId: res.job_id, phase: 'queued', pct: 100 });
                // File it into the notebook you're in - membership is doc-meta, so it works the
                // moment the id exists, long before the transcode lands.
                if (bucket) {
                    api(
                        `/api/identity/${root}/docs/${res.doc_id}/buckets/${encodeURIComponent(bucket)}`,
                        { method: 'PUT' }
                    ).catch(() => {});
                }
                // A rename typed while the bytes were in flight: apply it to the queued job now.
                if (namesRef.current[i] !== file.name) {
                    renameNow(i, { phase: 'queued', jobId: res.job_id, appliedName: file.name });
                }
            } catch (e) {
                patchRow(i, { phase: 'failed', error: e.message });
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Follow the ingest queue while anything is in it. A row crossing to `done` with a rename
    // still unapplied (typed while the worker held the job) retitles the finished document.
    const waiting = rows.some((r) => r.phase === 'queued');
    useEffect(() => {
        if (!waiting) return;
        const id = setInterval(async () => {
            try {
                const jobs = await api(`/api/identity/${root}/ingest`);
                const settle = []; // [i, row] pairs that just finished with a pending rename
                setRows((rs) =>
                    rs.map((r, i) => {
                        if (r.phase !== 'queued' || !r.jobId) return r;
                        const job = jobs.find((j) => j.job_id === r.jobId);
                        if (!job) return r;
                        if (job.status === 'done') {
                            const doneRow = { ...r, phase: 'done' };
                            if (namesRef.current[i] !== r.appliedName) settle.push([i, doneRow]);
                            return doneRow;
                        }
                        if (job.status === 'failed') {
                            return { ...r, phase: 'failed', error: job.error || 'processing failed' };
                        }
                        return { ...r, queueStatus: job.status };
                    })
                );
                for (const [i, row] of settle) renameNow(i, row);
            } catch {
                /* transient; the next tick retries */
            }
        }, 1000);
        return () => clearInterval(id);
    }, [waiting, root]);

    const anyInFlight = rows.some((r) => r.phase === 'uploading' || r.phase === 'queued');

    return html`<${Modal} title="File upload" onClose=${onClose}>
        <div class="upload-rows">
            ${rows.map(
                (r, i) => html`<div class="upload-row" key=${i}>
                    <div class="upload-row-top">
                        <input
                            class="upload-name"
                            value=${r.name}
                            disabled=${r.phase === 'failed'}
                            title="the file's name"
                            onInput=${(e) => {
                                namesRef.current[i] = e.currentTarget.value;
                                patchRow(i, { name: e.currentTarget.value });
                            }}
                            onBlur=${() => renameNow(i, r)}
                        />
                        <span class="upload-size">${fmtBytes(r.file.size)}</span>
                        <button
                            class="chip chip-button"
                            title="tags"
                            disabled=${!r.docId}
                            onClick=${() => patchRow(i, { tagsOpen: !r.tagsOpen })}
                        ><${Icons.tag} /></button>
                    </div>
                    ${r.phase === 'uploading' &&
                    html`<div class="upload-bar">
                        <div class="upload-bar-fill" style=${`width: ${r.pct}%`}></div>
                    </div>`}
                    ${r.phase === 'queued' &&
                    html`<div class="upload-status">
                        <span class="status-spin"><${Icons.spinner} /></span>
                        ${QUEUE_WORD[r.queueStatus] || 'processing…'}
                    </div>`}
                    ${r.phase === 'done' &&
                    html`<div class="upload-status upload-done">
                        <${Icons.done} /> processed and stored
                    </div>`}
                    ${r.phase === 'failed' &&
                    html`<div class="upload-status upload-failed">${r.error}</div>`}
                    ${/^video\//.test(r.file.type || '') &&
                    r.phase !== 'failed' &&
                    html`<div class="upload-note">
                        video support is young: the node speaks only a few codecs, so this may
                        come out sound-only or fail - in-browser pre-encoding (the video-ingest
                        pipeline) is the eventual fix.
                    </div>`}
                    ${r.tagsOpen &&
                    r.docId &&
                    html`<div class="upload-tags">
                        <${Annotations}
                            root=${root}
                            docId=${r.docId}
                            features=${{ date: false, description: false }}
                        />
                    </div>`}
                </div>`
            )}
        </div>
        <div class="modal-actions">
            ${anyInFlight &&
            html`<span class="upload-note">
                OK returns to the document - the upload keeps going and lands on its own.
            </span>`}
            <button class="modal-ok" onClick=${onClose}>OK</button>
        </div>
    </${Modal}>`;
};
