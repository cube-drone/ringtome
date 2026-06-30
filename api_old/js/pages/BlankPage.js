import { h, Component, render, createRef } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';

const BlankPage = () => {
    return html`
    <${BasicPageLayout} title="">

    <//>`;
}

export default BlankPage;