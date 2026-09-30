// The Writer's Links column (Curtis, 2026-10-01: "While I have a document open, Links displays first
// the incoming links to and then outgoing links from that document"). Both lists come off the
// mirror's search rows (pure/doclinks.js), which the node keeps current as bodies change, so the
// column follows a save without asking anything.
import { h } from 'preact';
import htm from 'htm';

import { openMirror, useLive } from '../mirror.js';
import { t } from '../i18n.js';
import { docHref } from '../links.js';
import { parseRingtome } from '../pure/ringtome.js';
import { incomingTo, outgoingOf, linkLabel } from '../pure/doclinks.js';
import { PaneHead } from '../panes.js';

const html = htm.bind(h);

const titleOf = (d) => (d && d.title) || t('doc.linkcol.untitled', 'untitled');

/// One outgoing link: your own note by its title and address; a Ringtome address in the app; the
/// web in a new tab. A link to a note that has since been deleted says so, and goes nowhere.
const Outgoing = ({ root, link, byId }) => {
    if (link.doc) {
        const d = byId.get(link.doc);
        return d
            ? html`<a class="links-row" href=${docHref(root, d.doc_id, { row: d })}>${titleOf(d)}</a>`
            : html`<span class="links-row links-row-gone">${link.text || link.doc.slice(0, 8)} · ${t('doc.linkcol.deleted', 'deleted')}</span>`;
    }
    if (parseRingtome(link.to)) {
        return html`<a class="links-row" href=${link.to}>${linkLabel(link)}</a>`;
    }
    return html`<a class="links-row links-row-web" href=${link.to} target="_blank" rel="noopener noreferrer" title=${link.to}>${linkLabel(link)}</a>`;
};

export const LinksColumn = ({ root, docId, docs, onTuck }) => {
    const rows = useLive(() => openMirror(root).search.toArray(), [root]);
    const byId = new Map((docs || []).map((d) => [d.doc_id, d]));
    const incoming = incomingTo(rows, docId)
        .map((id) => byId.get(id))
        .filter(Boolean)
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
    const outgoing = outgoingOf(rows, docId);
    return html`<aside class="links-column">
        <${PaneHead} label=${t('doc.linkcol.links', 'links')} onTuck=${onTuck} />
        ${!docId
            ? html`<p class="null-sub">${t('doc.linkcol.open-a-note', 'open a note to see what links to it, and what it links to.')}</p>`
            : html`
                  <h3 class="links-head">${t('doc.linkcol.linking-here', 'linking here')}</h3>
                  ${incoming.length === 0
                      ? html`<p class="null-sub">${t('doc.linkcol.nothing-links-here', 'nothing links here yet.')}</p>`
                      : incoming.map((d) => html`<a class="links-row" key=${d.doc_id} href=${docHref(root, d.doc_id, { row: d })}>${titleOf(d)}</a>`)}
                  <h3 class="links-head">${t('doc.linkcol.linked-from-here', 'linked from here')}</h3>
                  ${outgoing.length === 0
                      ? html`<p class="null-sub">${t('doc.linkcol.links-nowhere', "this note doesn't link anywhere yet.")}</p>`
                      : outgoing.map((link) => html`<${Outgoing} key=${link.to} root=${root} link=${link} byId=${byId} />`)}
              `}
    </aside>`;
};
