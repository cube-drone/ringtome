// Someone this server hosts, seen by its administrator (Curtis, 2026-11-06): the account here
// that manages a persona, and the note that goes with blocking one - kept apart from account.js,
// which the block modal can't import without a cycle (account.js -> person.js -> blockmodal.js).
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { accountHref } from './links.js';

const html = htm.bind(h);

/// The account here that manages a persona, for this place's administrator: `null` until asked,
/// and for anyone this server doesn't host. `ask` false asks nothing - a reader who doesn't
/// administer the server has no business with the question.
export const useHostedAccount = (root, ask = true) => {
    const [account, setAccount] = useState(null);
    useEffect(() => {
        let live = true;
        setAccount(null);
        if (!root || !ask) return undefined;
        api(`/api/admin/accounts/of/${root}`)
            .then((a) => live && setAccount(a))
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [root, ask]);
    return account;
};

/// Blocking someone this server hosts (Curtis, 2026-11-06): a block doesn't touch the server's own
/// users - they are the operator's to remove, never to starve (moderation.rs) - so an
/// administrator blocking one is told so, and pointed at the account, where sign-in can be switched
/// off or the account evicted. Nothing for an administrator's account or the reader's own, which
/// that page can't act on.
export const HostedHereNote = ({ account }) =>
    account &&
    !account.admin &&
    !account.yours &&
    html`<p class="hosted-here-note">
        ${t(
            'account.blocked-but-hosted',
            "They have an account on this server ({name}), and a block doesn't stop this server hosting them.",
            { name: account.username },
        )}
        ${account.sign_in_off_ms ? ` ${t('account.sign-in-already-off', 'Their sign-in is already switched off.')}` : ''}
        ${' '}<a href=${accountHref(account.id)}>${t('account.switch-off-or-evict', 'switch off their sign-in, or evict them')}</a>
    </p>`;
