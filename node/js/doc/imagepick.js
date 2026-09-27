// The image picker (Curtis, 2026-09-27): a modal of every picture in the person's own media,
// newest first, with a title search, a notebook menu and a tag cloud to narrow it. Choosing one
// hands it to `onPick({ doc, format, width, height, title })`. The drawing puts a picture on a
// layer of its own (pure/drawing.js, `addImage`); the profile makes one its picture, and offers
// drawings too (`drawings`, with `DrawingThumb` passed in to show them - this module is the
// drawing's, and cannot import it back). The filtering is pure/imagepick.js.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { Modal } from '../modal.js';
import { openMirror, useLive } from '../mirror.js';
import { pickPictures } from '../pure/imagepick.js';
import { togglePick } from '../pure/facets.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { FILES_BUCKET } from './upload.js';

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

    return html`<${Modal} wide=${true} title=${heading || t('doc.imagepick.add-an-image', 'add an image')} onClose=${onClose}>
        <div class="imagepick">
            <div class="imagepick-filters">
                <input
                    class="imagepick-search"
                    type="search"
                    value=${query}
                    placeholder=${t('doc.imagepick.search-titles', 'search titles')}
                    aria-label=${t('doc.imagepick.search-titles', 'search titles')}
                    onInput=${(e) => narrow(setQuery)(e.currentTarget.value)}
                />
            </div>
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
            ${cloud.length > 0 &&
            html`<div class="imagepick-tags">
                ${cloud.map(
                    ([tag, count]) => html`<button
                        key=${tag}
                        class=${tags.includes(tag) ? 'imagepick-tag active' : 'imagepick-tag'}
                        onClick=${() => narrow(setTags)(togglePick(tags, tag))}
                    >${tag} <span class="imagepick-tag-count">${count}</span></button>`
                )}
            </div>`}
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
