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

import { api } from './net.js';
import { Modal, fmtBytes } from './modal.js';
import { Annotations } from './annotations.js';
import { ensureTreeRoot } from './tree.js';
import { takeDocDropSwap } from './slugs.js';
import { Icons } from './icons.js';
// The in-browser video pre-encoder (the video-ingest spike, now in service): the HOSTILE decode
// happens in the browser's hardened, licensed decoder, and the server only ever sees
// our-encoder bytes - AV1-in-WebM (happy lane) or 320p APNG + Ogg Opus (universal fallback).
import { ingestVideo } from '../../video-ingest/src/index.js';

const html = htm.bind(h);

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

// The fallback lane's two blobs travel as multipart parts (`video` + `audio`); the happy lane's
// WebM goes through the plain binary route like any single blob. Same progress, same 202.
function uploadVideoParts(root, videoBlob, audioBlob, title, onPct) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(
            'POST',
            `/api/identity/${root}/docs/binary/video?title=${encodeURIComponent(title)}`
        );
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
        const parts = new FormData();
        parts.append('video', videoBlob, 'video');
        if (audioBlob) parts.append('audio', audioBlob, 'audio');
        xhr.send(parts);
    });
}

const QUEUE_WORD = {
    pending: 'waiting in the processing queue…',
    processing: 'processing…',
};

export const UploadFlow = ({ root, bucket, files, onClose, intoTree, onUploaded, onFailed }) => {
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
            // Video pre-encode bookkeeping: which lane it took, when the encode began (for the
            // elapsed readout), the intermediary's size, and whether audio had to be dropped.
            lane: null,
            encStart: null,
            outBytes: null,
            audioDropped: false,
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
                onFailed && onFailed(i); // the host removes this file's in-document placeholder
                return;
            }
            try {
                let res;
                if (/^video\//.test(file.type || '')) {
                    // Video first re-encodes IN THE BROWSER (the video-ingest contract): the
                    // hostile decode happens in the browser's hardened decoder, and the server
                    // receives only the normalized intermediary it can decode in safe Rust.
                    patchRow(i, { phase: 'encoding', encStart: Date.now() });
                    const out = await ingestVideo(file);
                    patchRow(i, {
                        lane: out.lane,
                        outBytes: out.video.size + (out.audio ? out.audio.size : 0),
                        audioDropped: out.lane === 'frames' && !out.audio,
                        phase: 'uploading',
                    });
                    res =
                        out.lane === 'av1'
                            ? await uploadBinary(root, out.video, namesRef.current[i], (pct) =>
                                  patchRow(i, { pct })
                              )
                            : await uploadVideoParts(
                                  root,
                                  out.video,
                                  out.audio,
                                  namesRef.current[i],
                                  (pct) => patchRow(i, { pct })
                              );
                } else {
                    res = await uploadBinary(root, file, namesRef.current[i], (pct) =>
                        patchRow(i, { pct })
                    );
                }
                patchRow(i, { docId: res.doc_id, jobId: res.job_id, phase: 'queued', pct: 100 });
                // The doc_id exists: the host swaps this file's in-document placeholder for
                // the real reference now (the body URL is stable; it self-describes while the
                // transcode is still running).
                onUploaded && onUploaded(i, file, res.doc_id, namesRef.current[i]);
                // File it into the notebook you're in - membership is doc-meta, so it works the
                // moment the id exists, long before the transcode lands.
                if (bucket) {
                    api(
                        `/api/identity/${root}/docs/${res.doc_id}/buckets/${encodeURIComponent(bucket)}`,
                        { method: 'PUT' }
                    ).catch(() => {});
                }
                // A tree-having app (Notes, Wiki) also files the upload into the tree - the
                // root's last child, same as "+ new item" - so it's visible and draggable into
                // place instead of invisibly unfiled. (The tree row appears once the transcode
                // lands a version; taxonomy membership itself works immediately.)
                if (intoTree && bucket) {
                    ensureTreeRoot(root, bucket)
                        .then((rid) =>
                            api(`/api/identity/${root}/taxonomies/${rid}/members/${res.doc_id}`, {
                                method: 'PUT',
                                body: JSON.stringify({}),
                            })
                        )
                        .catch(() => {});
                }
                // A rename typed while the bytes were in flight: apply it to the queued job now.
                if (namesRef.current[i] !== file.name) {
                    renameNow(i, { phase: 'queued', jobId: res.job_id, appliedName: file.name });
                }
            } catch (e) {
                patchRow(i, { phase: 'failed', error: e.message });
                onFailed && onFailed(i); // remove the placeholder; nothing landed
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

    // A once-a-second tick while anything is encoding, so the elapsed readout moves.
    const encoding = rows.some((r) => r.phase === 'encoding');
    const [, tickEnc] = useState(0);
    useEffect(() => {
        if (!encoding) return;
        const id = setInterval(() => tickEnc((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [encoding]);

    const anyInFlight = rows.some(
        (r) => r.phase === 'encoding' || r.phase === 'uploading' || r.phase === 'queued'
    );

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
                        <span class="upload-size">
                            ${fmtBytes(r.outBytes != null ? r.outBytes : r.file.size)}
                        </span>
                        <button
                            class="chip chip-button"
                            title="tags"
                            disabled=${!r.docId}
                            onClick=${() => patchRow(i, { tagsOpen: !r.tagsOpen })}
                        ><${Icons.tag} /></button>
                    </div>
                    ${r.phase === 'encoding' &&
                    html`<div class="upload-status">
                        <span class="status-spin"><${Icons.spinner} /></span>
                        re-encoding in your browser…
                        ${' '}${Math.max(0, Math.round((Date.now() - r.encStart) / 1000))}s
                        <span class="upload-note">
                            (the encoder runs at about playback speed - a two-minute clip takes
                            about two minutes)
                        </span>
                    </div>`}
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
                    ${r.lane === 'frames' &&
                    r.phase !== 'failed' &&
                    html`<div class="upload-note">
                        this browser can't encode AV1, so the frame-by-frame fallback is doing
                        the work - a bigger upload, the same result.
                    </div>`}
                    ${r.audioDropped &&
                    html`<div class="upload-note">
                        the audio track couldn't be processed (an unusual codec - AC-3/DTS can't
                        be decoded in a browser), so this uploads video-only.
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

/**
 * The CAPTURE side of upload, shared by every editing surface (the Editor's three doors, the
 * journal's drop-and-paste): plants a placeholder at the cursor per file, opens the modal,
 * swaps the placeholder for the real reference when the upload lands - or removes it on
 * failure. Also receives dragged document rows (the crosslink drag): the surface's native drop
 * inserts the link markup at the pointer, and this hook dresses the id-form in its cozy
 * address. The host renders `extras` (the hidden file input + the modal) and wires
 * catchDrop/allowFileDrag/catchPaste onto its surface; `pickFiles` opens the file picker.
 *
 * @param bucket    where landed uploads FILE (may deliberately differ from the doc's own
 *                  bucket - the journal files media into TurboNotes' home, never itself)
 * @param intoTree  also append landed uploads to the bucket's tree root
 * @param cursorPos () => offset in `body` where placeholders insert (null = append)
 */
export function useUploadCapture({
    root,
    bucket,
    intoTree,
    format,
    body,
    setBody,
    touched,
    cursorPos,
}) {
    const [uploadFiles, setUploadFiles] = useState(null); // File[] | null
    const filePickRef = useRef(null);
    const bodyNow = useRef('');
    bodyNow.current = body;
    const uploadTokens = useRef([]); // placeholder text per file index, for the open modal
    const captureFiles = (files) => {
        if (!files.length) return;
        const tokens = files.map(
            (f) => `[uploading "${f.name}" …${Math.random().toString(36).slice(2, 6)}]`
        );
        uploadTokens.current = tokens;
        const at = cursorPos ? cursorPos() : null;
        const pos = Math.min(at == null ? bodyNow.current.length : at, bodyNow.current.length);
        setBody(bodyNow.current.slice(0, pos) + tokens.join('\n') + bodyNow.current.slice(pos));
        touched();
        setUploadFiles(files);
    };
    // The final reference for a landed upload. The extension is guessed from the INPUT kind
    // (image -> avif, video -> webm, audio -> ogg - what the crush emits); it's decorative,
    // the served Content-Type is authoritative, and an unknown kind degrades to a plain link.
    const refFor = (file, uploadedId, name) => {
        const base = `/api/identity/${root}/docs/${uploadedId}/body`;
        const t = file.type || '';
        const ext = t.startsWith('image/')
            ? 'avif'
            : t.startsWith('video/')
            ? 'webm'
            : t.startsWith('audio/')
            ? 'ogg'
            : null;
        const label = (name || file.name || 'file').replace(/[[\]()]/g, '');
        const slug = label.replace(/[^\w.-]+/g, '_').replace(/\.[^.]*$/, '') || 'file';
        if (format === 'plaintext') return ext ? `${base}/${slug}.${ext}` : base;
        return ext ? `![${label}](${base}/${slug}.${ext})` : `[${label}](${base})`;
    };
    const swapToken = (i, replacement) => {
        const tok = uploadTokens.current[i];
        if (!tok || !bodyNow.current.includes(tok)) return; // deleted by hand: their call
        setBody(bodyNow.current.replace(tok, replacement));
        touched();
    };
    const onUploaded = (i, file, uploadedId, name) => swapToken(i, refFor(file, uploadedId, name));
    const onUploadFailed = (i) => swapToken(i, '');
    const catchDrop = (e) => {
        const dt = e.dataTransfer;
        const files = Array.from((dt && dt.files) || []);
        if (files.length) {
            e.preventDefault();
            e.stopPropagation();
            captureFiles(files);
            return;
        }
        const types = Array.from((dt && dt.types) || []);
        if (types.includes('application/x-ringtome-section')) {
            // A SECTION row from the tree isn't text - block the surface's native drop from
            // inserting its raw taxonomy id.
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (types.includes('application/x-ringtome-doc')) {
            // A document row (list or tree): the editing surface's NATIVE drop inserts the
            // dragged link markup at the pointer - we deliberately don't preventDefault - and
            // then the id-form link dresses itself in the cozy address once it computes. The
            // insertion lands a beat after this handler, so the swap retries briefly.
            const idText = dt.getData('text/plain');
            const swap = takeDocDropSwap(idText);
            if (swap) {
                swap.then((cozyText) => {
                    if (!cozyText || cozyText === idText) return;
                    let tries = 0;
                    const attempt = () => {
                        if (bodyNow.current.includes(idText)) {
                            setBody(bodyNow.current.replace(idText, cozyText));
                            touched();
                        } else if (++tries < 12) {
                            setTimeout(attempt, 100);
                        }
                    };
                    attempt();
                });
            }
        }
    };
    const allowFileDrag = (e) => {
        const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
        if (types.includes('Files')) e.preventDefault();
    };
    const catchPaste = (e) => {
        const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
        if (!files.length) return; // ordinary text paste - let it through untouched
        e.preventDefault();
        captureFiles(files);
    };
    const extras = html`
        <input
            type="file"
            multiple
            hidden
            ref=${filePickRef}
            onChange=${(e) => {
                const files = Array.from(e.currentTarget.files || []);
                if (files.length) captureFiles(files);
                e.currentTarget.value = ''; // so picking the same file again re-fires
            }}
        />
        ${uploadFiles &&
        html`<${UploadFlow}
            root=${root}
            bucket=${bucket}
            intoTree=${intoTree}
            files=${uploadFiles}
            onUploaded=${onUploaded}
            onFailed=${onUploadFailed}
            onClose=${() => setUploadFiles(null)}
        />`}
    `;
    return {
        catchDrop,
        allowFileDrag,
        catchPaste,
        pickFiles: () => filePickRef.current && filePickRef.current.click(),
        extras,
    };
}
