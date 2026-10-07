// The consent page (oauth.rs, plans/MCP.md Slice 5, 2026-10-06): an AI assistant - claude.ai,
// ChatGPT, anything that speaks MCP - asks to act as this account. The node asks the person here,
// in a signed-in browser, which is where every API key is made; saying yes sends the assistant
// back with a code it trades for a key named after it, listed under API keys in settings with the
// rest, and revoked there. Saying no sends it back with nothing.
//
// Routed at `/oauth/authorize` in the signed-in shell (index.js); a visitor who isn't signed in
// sees the front door at the same address, signs in there, and arrives here.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { api } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

/// The authorization request's own words, as the assistant sent them (oauth.rs `Ask`): passed to
/// the node twice - once to learn who is asking, once with the answer - and never changed here.
const ASKED = [
    'response_type',
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'state',
    'resource',
];

export const OAuthConsent = () => {
    const params = new URLSearchParams(window.location.search);
    const ask = Object.fromEntries(
        ASKED.filter((k) => params.has(k)).map((k) => [k, params.get(k)]),
    );
    const [asking, setAsking] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const query = new URLSearchParams(ask).toString();

    useEffect(() => {
        api(`/api/oauth/request?${query}`)
            .then(setAsking)
            .catch((e) => setError(e.message));
    }, [query]);

    const answer = async (approve) => {
        setBusy(true);
        try {
            const { redirect } = await api('/api/oauth/consent', {
                method: 'POST',
                body: JSON.stringify({ ...ask, approve }),
            });
            window.location.assign(redirect);
        } catch (e) {
            setError(e.message);
            setBusy(false);
        }
    };

    if (error) {
        return html`<div class="console oauth-consent">
            <h2><${Icons.aiAgent} /> ${t('oauthconsent.cant-connect', "This assistant can't connect")}</h2>
            <p class="form-error">${error}</p>
        </div>`;
    }
    if (!asking) {
        return html`<div class="console oauth-consent"><p class="null-sub">${t('oauthconsent.asking', 'asking…')}</p></div>`;
    }
    return html`<div class="console oauth-consent">
        <h2><${Icons.aiAgent} /> ${t('oauthconsent.connect-name', 'Connect {name}?', { name: asking.client.name })}</h2>
        <p>
            ${t(
                'oauthconsent.it-would-act-as-you',
                '{name} would act as you, {account}: read your feed and your notes, post and reply, chat, and use the Bank, as any of your personas.',
                { name: asking.client.name, account: asking.account },
            )}
        </p>
        <p>
            ${t(
                'oauthconsent.its-posts-say-so',
                'What it posts says "ai-agent", so the people who read it know an assistant made it.',
            )}
        </p>
        <p class="oauth-consent-small">
            ${t(
                'oauthconsent.disconnect-in-settings',
                'It gets a key of its own, named for it under API keys in your settings - revoke it there and it is disconnected at once. Saying yes sends you back to {where}.',
                { where: asking.goes_to },
            )}
        </p>
        <div class="oauth-consent-answers">
            <button class="oauth-consent-yes" type="button" disabled=${busy} onClick=${() => answer(true)}>
                ${t('oauthconsent.connect', 'connect')}
            </button>
            <button class="oauth-consent-no" type="button" disabled=${busy} onClick=${() => answer(false)}>
                ${t('oauthconsent.not-now', 'not now')}
            </button>
        </div>
    </div>`;
};
