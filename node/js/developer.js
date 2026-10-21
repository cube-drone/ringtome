// Developer Options (Curtis, 2026-10-11): a settings page of buttons for trying the app's own
// machinery - an example toast, an example error, browser notifications with their test, and a
// generous H$ 1,000,000 - offered to a node's administrators, and to everyone on a development
// build. Its entry sits above "log out" in the settings list (persona.js `SettingsList`). On a
// development build, someone not yet a node administrator is also offered "make me a node_admin"
// (2026-10-20), so the Server app is anyone's to try there.
//
// The page's gate only decides what is offered. The gift, the one button with consequences, is
// gated again by the node (bank.rs `gift_handler`), on the same two conditions.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { toast } from './toasts.js';
import { PushToggle } from './push.js';
import { isDevice } from './net.js';
import { formatHorseBucks } from './pure/horsebucks.js';
import { appHref } from './links.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// Does this page offer Developer Options? A node administrator (the account tag src/auth.rs
/// hands out, riding the session's whoami answer), or anyone on a development build - which the
/// node says in its page (src/ui.rs, the `app-environment` meta).
export function mayDevelop(session) {
    return isAdmin(session) || devBuild();
}

const isAdmin = (session) =>
    ((session && session.account && session.account.tags) || []).includes('node_admin');

function devBuild() {
    const meta =
        typeof document !== 'undefined' && document.querySelector('meta[name="app-environment"]');
    return !!meta && meta.getAttribute('content') === 'dev';
}

export const DeveloperOptions = ({ current, session }) => {
    const [busy, setBusy] = useState(false);
    if (!current || !current.root || !mayDevelop(session)) return null;
    const root = current.root;
    const gift = async () => {
        setBusy(true);
        try {
            const r = await api(`/api/identity/${root}/bank/gift`, { method: 'POST' });
            toast(
                t('developer.gift-given', '{amount} is yours: your balance is {balance}', {
                    amount: formatHorseBucks(r.pennies),
                    balance: formatHorseBucks(r.balance),
                }),
                {
                    action: {
                        label: t('developer.open-the-bank', 'open the bank'),
                        href: appHref('bank'),
                    },
                },
            );
        } catch (e) {
            toast(t('developer.no-gift', 'no gift: {message}', { message: e.message }), {
                kind: 'error',
            });
        }
        setBusy(false);
    };
    // A development build makes anyone a node administrator for asking (auth/routes.rs), so the
    // Server app can be tried by whoever is trying things. The answer carries the new tags, and
    // the session takes them at once.
    const becomeAdmin = async () => {
        setBusy(true);
        try {
            const account = await api('/api/auth/dev/node-admin', { method: 'POST' });
            if (session.setAccount) session.setAccount(account);
            toast(t('developer.youre-a-node-admin', 'you are a node administrator now'), {
                action: {
                    label: t('developer.open-the-server-app', 'open the Server app'),
                    href: appHref('device'),
                },
            });
        } catch (e) {
            toast(
                t('developer.not-made-admin', 'not made an administrator: {message}', {
                    message: e.message,
                }),
                {
                    kind: 'error',
                },
            );
        }
        setBusy(false);
    };
    const offerAdmin = devBuild() && !isAdmin(session);
    return html`<div class="persona-page">
        <div class="persona-page-head">
            <h1 class="persona-page-title">${t('developer.title', 'developer options')}</h1>
        </div>
        <p class="persona-menu-note">
            ${t('developer.who-sees-this', "for a node's administrators, and for everyone on a development build")}
        </p>
        <section class="developer-group">
            <h2 class="developer-heading">${t('developer.toasts', 'toasts')}</h2>
            <div class="developer-row">
                <button
                    class="developer-button jag-line"
                    onClick=${() =>
                        toast(
                            t(
                                'developer.example-toast',
                                'an example toast: it fades in five seconds, or holds while you point at it',
                            ),
                            {
                                action: {
                                    label: t('developer.open-the-bank', 'open the bank'),
                                    href: appHref('bank'),
                                },
                            },
                        )}
                >
                    ${t('developer.pop-an-example-toast', 'pop an example toast')}
                </button>
                <button
                    class="developer-button jag-line"
                    onClick=${() =>
                        toast(
                            t(
                                'developer.example-error',
                                "an example error: couldn't do the thing: the thing said no",
                            ),
                            {
                                kind: 'error',
                            },
                        )}
                >
                    ${t('developer.pop-an-example-error', 'pop an example error')}
                </button>
            </div>
        </section>
        ${
            /* The desktop app notifies natively, and the switch renders nothing there. */
            !isDevice() &&
            html`<section class="developer-group">
                <h2 class="developer-heading">${t('developer.notifications', 'notifications')}</h2>
                <${PushToggle} root=${root} withTest=${true} />
            </section>`
        }
        <section class="developer-group">
            <h2 class="developer-heading">${t('developer.horsebucks', 'HorseBucks')}</h2>
            <button class="developer-button jag-line" disabled=${busy} onClick=${gift}>
                ${t('developer.give-me-a-million', 'give me H$ 1,000,000')}
            </button>
        </section>
        ${
            offerAdmin &&
            html`<section class="developer-group">
                <h2 class="developer-heading">${t('developer.administering', 'administering')}</h2>
                <button class="developer-button jag-line" disabled=${busy} onClick=${becomeAdmin}>
                    ${t('developer.make-me-a-node-admin', 'make me a node_admin')}
                </button>
            </section>`
        }
    </div>`;
};
