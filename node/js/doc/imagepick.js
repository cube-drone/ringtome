// The drawing's image picker (Curtis, 2026-09-27): a modal of every picture in the person's own
// media, newest first, with a title search, a notebook menu and a tag cloud to narrow it. Choosing a
// picture hands it to `onPick({ doc, width, height, title })`; the drawing puts it on a layer of
// its own (pure/drawing.js, `addImage`). The filtering is pure/imagepick.js.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { Modal } from '../modal.js';
import { openMirror, useLive } from '../mirror.js';
import { pickPictures } from '../pure/imagepick.js';
import { togglePick } from '../pure/facets.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/// How many pictures show before "show more": a collection in the thousands would otherwise ask
/// for every thumbnail at once.
const PAGE = 120;

export const ImagePickModal = ({ root, onPick, onClose }) => {
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const [query, setQuery] = useState('');
    const [bucket, setBucket] = useState('');
    const [tags, setTags] = useState([]);
    const [shown, setShown] = useState(PAGE);
    const { pictures, tags: cloud, buckets } = pickPictures(docs || [], { query, bucket: bucket || null, tags });
    const narrow = (fn) => (value) => {
        fn(value);
        setShown(PAGE);
    };

    return html`<${Modal} wide=${true} title=${t('doc.imagepick.add-an-image', 'add an image')} onClose=${onClose}>
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
                <select
                    class="imagepick-bucket"
                    value=${bucket}
                    aria-label=${t('doc.imagepick.notebook', 'notebook')}
                    onChange=${(e) => narrow(setBucket)(e.currentTarget.value)}
                >
                    <option value="">${t('doc.imagepick.every-notebook', 'every notebook')}</option>
                    ${buckets.map((b) => html`<option key=${b} value=${b}>${b}</option>`)}
                </select>
            </div>
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
                                  onClick=${() => onPick({ doc: doc.doc_id, width: doc.media.width, height: doc.media.height, title: doc.title || '' })}
                              >
                                  <span class="imagepick-thumb drawing-floor">
                                      ${doc.media.has_thumb &&
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
