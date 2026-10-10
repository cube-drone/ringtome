// Settings (2026-10-09): every setting a person has, as an app of its own - second in the stack,
// after Persona - rather than a disclosure on their own page that only they knew to open (Curtis:
// "They're getting so expansive that I'm thinking they deserve an app all to themselves"). Its
// pages are the ones that disclosure led to, moved under it: `/ringtome/settings/<page>`. The
// old addresses under `/ringtome/persona/` redirect (index.js `SettingsMoved`), and the gear on
// your own page leads here.
import { h } from 'preact';
import htm from 'htm';

import { SettingsList } from '../persona.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

export const SettingsApp = ({ persona, session }) => {
    if (!persona || !persona.current) return null;
    return html`<div class="persona-page settings-app">
        <div class="persona-page-head">
            <h1 class="persona-page-title">${t('settings.title', 'your settings')}</h1>
        </div>
        <${SettingsList} persona=${persona} session=${session} />
    </div>`;
};
