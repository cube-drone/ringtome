import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';

const LoadingPage = () => {
    return html`
    <${BasicPageLayout} loading=${true} title="Loading...">
        You'll never see this!
    <//>`;
}

export default LoadingPage;