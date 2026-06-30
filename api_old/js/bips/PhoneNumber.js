import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import { Phone, Check, ShieldQuestionMark } from 'lucide-preact';

const html = htm.bind(h);

const PhoneNumber = ({phoneNumber, verified=false}) => {

    // if a phone number looks like this: 12345678901, we format it to (123) 456-7890
    // if a phone number looks like this: 234567890, we format it to (234) 567-890
    let formattedNumber = phoneNumber;
    if (phoneNumber && phoneNumber.length === 11) {
        formattedNumber = `(${phoneNumber.slice(0, 3)}) ${phoneNumber.slice(3, 6)}-${phoneNumber.slice(6)}`;
    }
    else if (phoneNumber && phoneNumber.length === 10) {
        formattedNumber = `(${phoneNumber.slice(0, 3)}) ${phoneNumber.slice(3, 6)}-${phoneNumber.slice(6)}`;
    }

    return html`
    <span class="phone-number">
        <${Phone} class="phone-number-icon" size="12" strokeWidth="3" />
        <a class="phone-number-link" href="tel:${phoneNumber}">
            ${formattedNumber ? formattedNumber : '???'}
        </a>
        ${verified ? html`<${Check} class="phone-number-verified" size="16" strokeWidth="5" />` : html`<${ShieldQuestionMark} class="phone-number-unverified" size="16" strokeWidth="5" />`}
    </span>
    `;

};

export default PhoneNumber;