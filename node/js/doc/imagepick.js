// The image picker (Curtis, 2026-09-27): a modal of every picture in the person's own media,
// newest first, with a title search, a notebook menu and a tag cloud to narrow it. Choosing one
// hands it to `onPick({ doc, format, width, height, title })`. The drawing puts a picture on a
// layer of its own (pure/drawing.js, `addImage`); the profile makes one its picture, and offers
// drawings too (`drawings`, with `DrawingThumb` passed in to show them - this module is the
// drawing's, and cannot import it back). The filtering is pure/imagepick.js.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { Modal } from '../modal.js';
import { openMirror, useLive } from '../mirror.js';
import { pickPictures, isPicture } from '../pure/imagepick.js';
import { api } from '../net.js';
import { togglePick } from '../pure/facets.js';
import { FacetRow, narrowTitle } from '../facets.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { FILES_BUCKET, uploadBinary } from './upload.js';

const html = htm.bind(h);

/// How many pictures show before "show more": a collection in the thousands would otherwise ask
/// for every thumbnail at once.
const PAGE = 120;

export const ImagePickModal = ({ root, onPick, onClose, drawings = false, DrawingThumb = null, heading = null }) => {
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const [query, setQuery] = useState('');
    const [bucket, setBucket] = useState('');
    const [tags, setTags] = useState([]);
    const [shown, setShown] = useState(PAGE);
    const { pictures, tags: cloud, buckets: holding } = pickPictures(docs || [], { query, bucket: bucket || null, tags, drawings });
    // "files" always second, after "every notebook" (Curtis, 2026-09-27) - where uploads land, so the
    // first place to look - wearing a disk rather than a book; then the notebooks holding anything.
    const buckets = [FILES_BUCKET, ...holding.filter((b) => b !== FILES_BUCKET)];
    const narrow = (fn) => (value) => {
        fn(value);
        setShown(PAGE);
    };

    // Upload from this computer (Curtis, 2026-09-29: setting a profile picture on a new site meant
    // uploading somewhere else first). The picture goes up as any upload does, is filed in "files",
    // and - once the node has taken it in - is picked exactly as if it had been clicked in the grid.
    // `upload`: null, or { phase: 'sending' | 'preparing' | 'failed', pct, doc, job, error }.
    const [upload, setUpload] = useState(null);
    const fileRef = useRef(null);
    const sendFile = async (file) => {
        if (!file) return;
        setUpload({ phase: 'sending', pct: 0 });
        try {
            const res = await uploadBinary(root, file, file.name, (pct) => setUpload((u) => (u ? { ...u, pct } : u)));
            await api(`/api/identity/${root}/docs/${res.doc_id}/buckets/${encodeURIComponent(FILES_BUCKET)}`, { method: 'PUT' }).catch(() => {});
            setUpload({ phase: 'preparing', doc: res.doc_id, job: res.job_id, title: file.name });
        } catch (e) {
            setUpload({ phase: 'failed', error: e.message });
        }
    };
    const fileChosen = (e) => {
        const input = e.currentTarget;
        sendFile(input.files && input.files[0]);
        input.value = null; // the same file chosen again is a fresh choice
    };
    // Taken in: the finished picture arrives in the mirror, and it is the pick.
    useEffect(() => {
        if (!upload || upload.phase !== 'preparing') return;
        const row = (docs || []).find((d) => d.doc_id === upload.doc);
        if (!row || !row.media) return;
        if (!isPicture(row)) {
            setUpload({ phase: 'failed', error: t('doc.imagepick.not-a-still', "that isn't a still picture - an animation becomes a video, and this wants a picture") });
            return;
        }
        setUpload(null);
        onPick({ doc: row.doc_id, format: row.format, width: row.media.width, height: row.media.height, animation: !!row.media.animation, title: row.title || upload.title || '' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docs, upload]);
    // ...or refused: the ingest queue says why.
    useEffect(() => {
        if (!upload || upload.phase !== 'preparing' || !upload.job) return undefined;
        const id = setInterval(async () => {
            const jobs = await api(`/api/identity/${root}/ingest`).catch(() => []);
            const job = (jobs || []).find((j) => j.job_id === upload.job);
            if (job && job.status === 'failed') setUpload({ phase: 'failed', error: job.error || t('doc.imagepick.could-not-take-it-in', "that picture couldn't be taken in") });
        }, 1500);
        return () => clearInterval(id);
    }, [upload, root]);

    const uploadNote = !upload
        ? null
        : upload.phase === 'sending'
          ? t('doc.imagepick.uploading', 'uploading… {pct}%', { pct: upload.pct || 0 })
          : upload.phase === 'preparing'
            ? t('doc.imagepick.preparing', 'preparing the picture…')
            : upload.error;
    return html`<${Modal} wide=${true} title=${heading || t('doc.imagepick.add-an-image', 'add an image')} onClose=${onClose}>
        <div class="imagepick">
            <div class="imagepick-filters">
                <button
                    class="imagepick-upload"
                    type="button"
                    disabled=${upload && upload.phase !== 'failed'}
                    onClick=${() => fileRef.current && fileRef.current.click()}
                ><${Icons.upload} /> ${t('doc.imagepick.upload-from-this-computer', 'upload from this computer')}</button>
                <input
                    ref=${fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/apng,image/bmp,image/tiff"
                    hidden
                    onChange=${fileChosen}
                />
                <input
                    class="imagepick-search"
                    type="search"
                    value=${query}
                    placeholder=${t('doc.imagepick.search-titles', 'search titles')}
                    aria-label=${t('doc.imagepick.search-titles', 'search titles')}
                    onInput=${(e) => narrow(setQuery)(e.currentTarget.value)}
                />
            </div>
            ${upload &&
            html`<p class=${upload.phase === 'failed' ? 'form-error' : 'null-sub'}>
                ${uploadNote}
            </p>`}
                        ${/* The notebooks - sketchbooks too, now that drawings have them (Curtis, 2026-09-27) -
                as a row of their own above the tags: one at a time, or every one. */ ''}
            ${buckets.length > 0 &&
            html`<div class="imagepick-buckets" role="group" aria-label=${t('doc.imagepick.notebook', 'notebook')}>
                <button
                    class=${bucket ? 'imagepick-bucket' : 'imagepick-bucket active'}
                    onClick=${() => narrow(setBucket)('')}
                ><${Icons.notebook} /> ${t('doc.imagepick.every-notebook', 'every notebook')}</button>
                ${buckets.map(
                    (b) => html`<button
                        key=${b}
                        class=${bucket === b ? 'imagepick-bucket active' : 'imagepick-bucket'}
                        onClick=${() => narrow(setBucket)(bucket === b ? '' : b)}
                    ><${b === FILES_BUCKET ? Icons.filesBucket : Icons.notebook} /> ${b}</button>`
                )}
            </div>`}
            ${/* One line of the commonest, then "more" (facets.js, 2026-10-02): every tag at once
                took the whole picker once an import brought some 250. */ ''}
            ${cloud.length > 0 &&
            html`<${FacetRow}
                label=${t('doc.imagepick.tagged', 'tagged')}
                items=${cloud.map(([value, count]) => ({ value, count }))}
                picked=${tags}
                out=${[]}
                onToggle=${(tag) => narrow(setTags)(togglePick(tags, tag))}
                titleOf=${narrowTitle}
            />`}
            ${pictures.length === 0
                ? html`<p class="null-sub">
                      ${docs && docs.length
                          ? t('doc.imagepick.no-pictures-match', 'no pictures match.')
                          : t('doc.imagepick.no-pictures-yet', 'no pictures yet - upload one in any notebook and it will be here.')}
                  </p>`
                : html`<ul class="imagepick-grid">
                      ${pictures.slice(0, shown).map(
                          (doc) => html`<li key=${doc.doc_id}>
                              <button
                                  class="imagepick-item"
                                  title=${doc.title || ''}
                                  onClick=${() =>
                                      onPick({
                                          doc: doc.doc_id,
                                          format: doc.format,
                                          width: doc.media ? doc.media.width : null,
                                          height: doc.media ? doc.media.height : null,
                                          animation: !!(doc.media && doc.media.animation),
                                          title: doc.title || '',
                                      })}
                              >
                                  <span class="imagepick-thumb drawing-floor">
                                      ${doc.format === 'drawing'
                                          ? DrawingThumb && html`<${DrawingThumb} root=${root} doc=${doc} big=${true} />`
                                          : doc.media.has_thumb &&
                                            html`<img src=${`/api/identity/${root}/docs/${doc.doc_id}/thumb?v=${doc.head}`} alt="" loading="lazy" />`}
                                  </span>
                                  <span class="imagepick-title">${doc.title || t('doc.imagepick.untitled', 'untitled')}</span>
                              </button>
                          </li>`
                      )}
                  </ul>`}
            ${pictures.length > shown &&
            html`<button class="imagepick-more" onClick=${() => setShown((n) => n + PAGE)}>
                ${t('doc.imagepick.show-more', 'show more ({left} left)', { left: pictures.length - shown })}
            </button>`}
        </div>
    </${Modal}>`;
};
