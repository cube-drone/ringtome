// Storage (2026-11-20): what hosting takes. People weighing the app ask "how much space am I
// giving up?" (Curtis), and until this page nothing answered them. Three figures, each a fact
// about this one computer or server: everything the place keeps, by kind; what the viewer's own
// persona takes of it; and what each person they follow takes. One of the place's settings pages
// (serversettings.js), open to everyone it hosts.
//
// The node measures (node/src/storage.rs, `overview_handler`); the arithmetic of laying it out is
// pure/storageshare.js. Every bar is a share of the place's total, so the page reads at a glance
// as "this much of what's here is that".
import { h } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api, isDevice } from './net.js';
import { t } from './i18n.js';
import { personHref } from './links.js';
import { Pie } from './pie.js';
import { sizeLabel } from './pure/backups.js';
import { laneParts, peopleShown, personParts, placeParts, shareOf } from './pure/storageshare.js';
import { wordsFor } from './speakable.js';

const html = htm.bind(h);

/// How often the page asks again while it is open: the node walks its disk at most once a minute.
const STORAGE_EVERY_MS = 60000;

/// And how soon while some of the people followed are still being counted: the node counts a few
/// more each time it is asked.
const COUNTING_EVERY_MS = 4000;

/// Each kind of thing the place keeps: its name, and what that means to a person.
const KIND_WORDS = () => ({
    files: [
        t('storage.kind-files', 'files'),
        t(
            'storage.kind-files-sub',
            'pictures, drawings, recordings and attachments - each kept once, however many people have it',
        ),
    ],
    chains: [
        t('storage.kind-chains', 'records'),
        t(
            'storage.kind-chains-sub',
            'posts, notes, messages and their history, for you and everyone kept here',
        ),
    ],
    backups: [
        t('storage.kind-backups', 'backups'),
        t('storage.kind-backups-sub', 'the copies made on the Backups page'),
    ],
    other: [
        t('storage.kind-other', 'everything else'),
        t('storage.kind-other-sub', "the app's own bookkeeping and keys"),
    ],
});

/// Each kind of file a persona has, by name.
export const FILE_WORDS = () => ({
    pictures: [t('storage.file-pictures', 'pictures')],
    video: [t('storage.file-video', 'video')],
    audio: [t('storage.file-audio', 'audio')],
    writing: [t('storage.file-writing', 'writing')],
    other: [t('storage.file-other', 'other files')],
});

/// The two lanes the viewer's files are in: what each is called, and what being in it means.
const LANE_WORDS = () => ({
    public: [
        t('storage.lane-public', 'public files'),
        t('storage.lane-public-sub', 'anyone following you keeps a copy'),
    ],
    private: [
        t('storage.lane-private', 'private files'),
        t('storage.lane-private-sub', 'kept only on your own computers'),
    ],
});

/// A kind's colour, the pie's slice and the legend's swatch alike (serversettings.css).
const KIND_CLASS = {
    records: 'storage-kind-records',
    pictures: 'storage-kind-pictures',
    video: 'storage-kind-video',
    audio: 'storage-kind-audio',
    writing: 'storage-kind-writing',
    other: 'storage-kind-other',
};

/// Parts as a pie with each part's size beside it. `label` names the pie to a screen reader.
export const Breakdown = ({ parts, words, label }) => {
    const name = (kind) =>
        kind === 'records' ? t('storage.records-short', 'records') : words[kind][0];
    return html`
        <div class="storage-lane-body">
            <${Pie}
                class="storage-pie"
                parts=${parts.map((part) => part.bytes)}
                classes=${parts.map((part) => KIND_CLASS[part.kind])}
                labels=${parts.map((part) => `${name(part.kind)}: ${sizeLabel(part.bytes)}`)}
                label=${label}
                empty="storage-pie-empty"
            />
            ${
                parts.length === 0
                    ? html`<p class="null-sub">${t('storage.lane-empty', 'nothing here yet')}</p>`
                    : html`<dl class="storage-legend">
                          ${parts.map(
                              (part) => html`
                                  <div key=${part.kind} class="storage-part">
                                      <dt>
                                          <span class=${`storage-swatch ${KIND_CLASS[part.kind]}`}></span>
                                          ${name(part.kind)}
                                      </dt>
                                      <dd>${sizeLabel(part.bytes)}</dd>
                                  </div>
                              `,
                          )}
                      </dl>`
            }
        </div>
    `;
};

/// One lane of the viewer's files (Curtis, 2026-11-20: "for each I'd like to see how they split
/// ... a good use for pie charts"): its size, a pie of its kinds, and each kind's size beside it.
const Lane = ({ lane, words }) => {
    const [name, sub] = LANE_WORDS()[lane.lane];
    return html`
        <div class="storage-lane">
            <div class="storage-row-head">
                <span class="storage-row-label">${name}</span>
                <span class="storage-row-size">${sizeLabel(lane.bytes)}</span>
            </div>
            <small class="storage-row-sub">${sub}</small>
            <${Breakdown} parts=${lane.parts} words=${words} label=${name} />
        </div>
    `;
};

/// One figure: what it is, how big, and its share of the place's total as a bar.
const Row = ({ label, sub, bytes, whole, href, note, parts }) => html`
    <li class="storage-row">
        <div class="storage-row-head">
            ${
                href
                    ? html`<a class="storage-row-label" href=${href}>${label}</a>`
                    : html`<span class="storage-row-label">${label}</span>`
            }
            <span class="storage-row-size">${sizeLabel(bytes)}</span>
        </div>
        <div class="storage-bar"><span style=${`width: ${shareOf(bytes, whole)}%`}></span></div>
        ${sub && html`<small class="storage-row-sub">${sub}</small>`}
        ${parts}
        ${note && html`<small class="storage-row-sub">${note}</small>`}
    </li>
`;

/// What this browser (or the app's own window) keeps for itself, beside the place's files: the
/// page's local copy for speed. Asked of the browser; null where it will not say.
const useBrowserBytes = () => {
    const [bytes, setBytes] = useState(null);
    useEffect(() => {
        let live = true;
        const estimate =
            typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate;
        if (estimate) {
            estimate
                .call(navigator.storage)
                .then((e) => live && setBytes(e && e.usage >= 0 ? e.usage : null))
                .catch(() => {});
        }
        return () => {
            live = false;
        };
    }, []);
    return bytes;
};

export const StoragePage = ({ current }) => {
    const root = current && current.root;
    const [answer, setAnswer] = useState(null);
    const [error, setError] = useState('');
    const [everyone, setEveryone] = useState(false);
    const browserBytes = useBrowserBytes();
    const load = useCallback(() => {
        if (!root) return;
        api(`/api/identity/${root}/storage/overview`)
            .then((a) => {
                setAnswer(a);
                setError('');
            })
            .catch((e) => setError(e.message));
    }, [root]);
    useEffect(() => {
        setAnswer(null);
        load();
    }, [load]);
    const counting = !!answer && (answer.following || []).some((p) => !p.counted);
    useEffect(() => {
        const again = setInterval(load, counting ? COUNTING_EVERY_MS : STORAGE_EVERY_MS);
        return () => clearInterval(again);
    }, [load, counting]);
    if (!answer) {
        return html`<div class="device">${error ? html`<p class="form-error">${error}</p>` : html`<p class="null-sub">${t('storage.measuring', 'measuring…')}</p>`}</div>`;
    }
    const { place, persona, following, others } = answer;
    const whole = place.total_bytes;
    const words = KIND_WORDS();
    const fileWords = FILE_WORDS();
    const { shown, rest } = peopleShown(following, everyone);
    return html`
        <div class="device storage-page">
            <h2 class="computers-title">${t('device.storage', 'Storage')}</h2>
            ${error && html`<p class="form-error">${error}</p>`}

            <section class="storage-section">
                <h3 class="computers-subtitle">
                    ${isDevice() ? t('storage.on-this-computer', 'on this computer') : t('storage.on-this-server', 'on this server')}
                </h3>
                <p class="storage-total">${sizeLabel(whole)}</p>
                ${
                    place.disk_total_bytes > 0 &&
                    html`<p class="storage-disk">
                        ${t('storage.disk-free-total', '{free} Free / {total} Total', {
                            free: sizeLabel(place.disk_free_bytes),
                            total: sizeLabel(place.disk_total_bytes),
                        })}
                    </p>`
                }
                <ul class="storage-rows">
                    ${placeParts(place).map(
                        ({ kind, bytes }) =>
                            html`<${Row} key=${kind} label=${words[kind][0]} sub=${words[kind][1]} bytes=${bytes} whole=${whole} />`,
                    )}
                </ul>
                ${
                    browserBytes > 0 &&
                    html`<p class="null-sub">
                        ${t('storage.browser-cache', '{size}: Browser Cache', { size: sizeLabel(browserBytes) })}
                    </p>`
                }
            </section>

            <section class="storage-section">
                <h3 class="computers-subtitle">
                    ${t('storage.you', 'you: {name}', { name: (current && current.name) || wordsFor(root).join('-') })}
                </h3>
                <p class="storage-total">${sizeLabel(persona.bytes)}</p>
                <ul class="storage-rows">
                    <${Row}
                        label=${t('storage.your-records', 'your records')}
                        sub=${t('storage.your-records-sub', 'everything you have written, public and private, and its history')}
                        bytes=${persona.chains_bytes}
                        whole=${whole}
                    />
                </ul>
                <div class="storage-lanes">
                    ${laneParts(persona).map(
                        (lane) =>
                            html`<${Lane} key=${lane.lane} lane=${lane} words=${fileWords} />`,
                    )}
                </div>
            </section>

            <section class="storage-section">
                <h3 class="computers-subtitle">
                    ${t('storage.people-you-follow', 'people you follow ({n})', { n: (following || []).length })}
                </h3>
                ${
                    (following || []).length === 0
                        ? html`<p class="null-sub">${t('storage.nobody-followed-here', 'Nobody you follow is kept here yet.')}</p>`
                        : html`<ul class="storage-rows">
                              ${shown.map(
                                  (p) =>
                                      html`<${Row}
                                          key=${p.root}
                                          label=${p.name || wordsFor(p.root).join('-')}
                                          href=${personHref(p.root)}
                                          bytes=${p.bytes}
                                          whole=${whole}
                                          parts=${p.counted && html`<${Breakdown} parts=${personParts(p)} words=${fileWords} label=${p.name || wordsFor(p.root).join('-')} />`}
                                          note=${p.counted ? '' : t('storage.still-counting', 'still counting their files')}
                                      />`,
                              )}
                          </ul>`
                }
                ${
                    rest > 0 &&
                    html`<button class="people-more" onClick=${() => setEveryone(true)}>
                    ${t('storage.show-everyone', 'show everyone ({n} more)', { n: rest })}
                </button>`
                }
                ${
                    others.people > 0 &&
                    html`<ul class="storage-rows">
                    <${Row}
                        label=${t('storage.everyone-else', 'everyone else kept here ({n})', { n: others.people })}
                        sub=${
                            isDevice()
                                ? t(
                                      'storage.everyone-else-sub-device',
                                      'your other personas, and people kept on the word of someone you trust',
                                  )
                                : t(
                                      'storage.everyone-else-sub-server',
                                      'the other people this place hosts, and the people they follow',
                                  )
                        }
                        bytes=${others.bytes}
                        whole=${whole}
                    />
                </ul>`
                }
                <p class="null-sub">
                    ${t(
                        'storage.shared-once',
                        'A file two people both have is kept once and counted for each of them, so these can add up to more than the total.',
                    )}
                    ${counting ? ` ${t('storage.counting-soon', 'Files are counted a few people at a time; the rest will follow shortly.')}` : ''}
                </p>
            </section>
        </div>
    `;
};
