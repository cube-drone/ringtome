// An account, as this place's administrator sees it (Curtis, 2026-10-20; node/src/accounts.rs):
// reached from any persona's page here, it lists every persona the account manages, and holds
// the two things an administrator may do to it - switch its sign-in off and back on, or evict it.
// Nobody else is offered the way here, and the node refuses anyone else at every door regardless.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { appHref, accountHref } from './links.js';
import { askYes } from './modal.js';
import { formatWhen } from './pure/when.js';
import { sizeLabel } from './pure/backups.js';
import { PersonRow } from './person.js';

const html = htm.bind(h);

/// What evicting would free: the sum of each persona's figure, once every one is tallied.
const evictBytes = (personas) =>
    personas.every((p) => p.storage)
        ? personas.reduce((n, p) => n + p.storage.evict_bytes, 0)
        : null;

export const AccountPage = ({ id, current }) => {
    const [account, setAccount] = useState(undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [evicted, setEvicted] = useState(null);
    useEffect(() => {
        setAccount(undefined);
        api(`/api/admin/accounts/${id}`)
            .then(setAccount)
            .catch((e) => {
                setAccount(null);
                setError(e.message);
            });
    }, [id]);

    if (evicted) {
        return html`<div class="device">
            <h2 class="computers-title">${t('account.evicted', 'Evicted')}</h2>
            <p class="null-sub">${t('account.evicted-sub', '{name} no longer has an account here, and its personas have left this place.', { name: evicted })}</p>
            <a class="removal-option" href=${appHref('device')}>
                <span class="removal-option-title">${t('account.back-to-the-server', 'back to the server')}</span>
            </a>
        </div>`;
    }
    if (account === undefined) {
        return html`<div class="device"><p class="null-sub">${t('account.looking', 'looking…')}</p></div>`;
    }
    if (account === null) {
        return html`<div class="device"><p class="form-error">${error}</p></div>`;
    }

    const off = account.sign_in_off_ms != null;
    // Neither act is offered on an administrator's account, yours included (accounts.rs says why).
    const untouchable = account.yours
        ? t('account.this-is-your-own-account', 'This is your own account.')
        : account.admin
          ? t(
                'account.an-administrators-account',
                'This account runs this place too. To switch it off or evict it, take its administrator status away first.',
            )
          : '';
    const frees = evictBytes(account.personas);
    const since = t('account.signed-up', 'An account here since {when}.', {
        when: formatWhen(account.created_ms),
    });
    const offSince = off
        ? t('account.sign-in-is-off-since', 'Signing in has been switched off since {when}.', {
              when: formatWhen(account.sign_in_off_ms),
          })
        : '';

    const switchSignIn = async () => {
        if (
            !off &&
            !(await askYes({
                title: t('account.switch-off-title', 'switch off signing in'),
                body: t(
                    'account.switch-off-body',
                    '{name} is signed out everywhere, and cannot sign in again until you switch it back on. Its personas stay here as they are.',
                    { name: account.username },
                ),
                yes: t('account.switch-off-yes', 'switch it off'),
            }))
        )
            return;
        setBusy(true);
        setError('');
        try {
            setAccount(
                await api(`/api/admin/accounts/${id}/sign-in`, {
                    method: 'POST',
                    body: JSON.stringify({ on: off }),
                }),
            );
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const evict = async () => {
        if (
            !(await askYes({
                title: t('account.evict-title', 'evict this account'),
                body: t(
                    'account.evict-body',
                    '{name} and every persona it manages leave this place for good. A persona that lives on other computers too goes on there; one that lived only here is gone, except for the copies other people keep and its spare key.',
                    { name: account.username },
                ),
                yes: t('account.evict-yes', 'evict it'),
                danger: true,
            }))
        )
            return;
        setBusy(true);
        setError('');
        try {
            await api(`/api/admin/accounts/${id}`, { method: 'DELETE' });
            setEvicted(account.username);
        } catch (e) {
            setError(e.message);
            setBusy(false);
        }
    };

    return html`
        <div class="device">
            <h2 class="computers-title">${account.username}</h2>
            <p class="null-sub">${since} ${offSince}</p>
            <h3 class="computers-subtitle">${t('account.its-personas', 'its personas')}</h3>
            ${
                account.personas.length === 0
                    ? html`<p class="null-sub">${t('account.no-personas', 'none yet')}</p>`
                    : html`<div class="account-personas">
                    ${account.personas.map((p) => html`<${PersonRow} key=${p.root} root=${p.root} current=${current} storage=${p.storage} />`)}
                </div>`
            }
            ${
                untouchable
                    ? html`<p class="null-sub">${untouchable}</p>`
                    : html`
                <button type="button" class="removal-option" disabled=${busy} onClick=${switchSignIn}>
                    <span class="removal-option-title">${off ? t('account.switch-sign-in-back-on', 'switch signing in back on') : t('account.switch-sign-in-off', 'switch off signing in')}</span>
                    <span class="removal-option-sub">${off ? t('account.switch-on-sub', 'they sign in as before, and their API keys work again') : t('account.switch-off-sub', 'signs them out everywhere; their personas stay')}</span>
                </button>
                <button type="button" class="removal-go" disabled=${busy} onClick=${evict}>${t('account.evict', 'evict this account')}</button>
                ${frees != null && html`<p class="null-sub">${t('account.evicting-frees', 'Evicting it frees about {size} here, once the mirror sweep has been round.', { size: sizeLabel(frees) })}</p>`}
            `
            }
            ${error && html`<p class="form-error">${error}</p>`}
        </div>
    `;
};

/// On a persona's page, for this place's administrator: the way to the account that manages the
/// persona - when one here does. Asks once per persona; says nothing for anyone not hosted here.
export const AccountLink = ({ root }) => {
    const [account, setAccount] = useState(null);
    useEffect(() => {
        let live = true;
        setAccount(null);
        api(`/api/admin/accounts/of/${root}`)
            .then((a) => live && setAccount(a))
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [root]);
    if (!account) return null;
    return html`<p class="id-account-link">
        <a href=${accountHref(account.id)}>${t('account.their-account-here', 'their account here: {name}', { name: account.username })}</a>
    </p>`;
};
