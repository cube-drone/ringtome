import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

const html = htm.bind(h);

import { LoaderCircle } from 'lucide-preact';

const Loading = ({center, margin, size=24, strokeWidth=2, ...props}) => {

    let extraStyles = '';
    if (center) {
        extraStyles += ' loading-center';
    }
    if (margin) {
        extraStyles += ' loading-margin';
    }

    return html`
        <div class="loading-container ${extraStyles}" ...${props}>
            <${LoaderCircle} class="spin" size=${size} strokeWidth=${strokeWidth} />
        </div>
    `;
};

export default Loading;