
import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import { Mail, Check, ShieldQuestionMark } from 'lucide-preact';

const html = htm.bind(h);

const Email = ({email, verified=false}) => {

    return html`
    <span class="email">
        <${Mail} class="email-icon" size="12" strokeWidth="3" />
        <a class="email-link" href="mailto:${email}">
            ${email ? email : '???'}
        </a>
        ${verified ? html`<${Check} class="email-verified" size="16" strokeWidth="5" />` : html`<${ShieldQuestionMark} class="email-unverified" size="16" strokeWidth="5" />`}

    </span>
    `;
};

export default Email;