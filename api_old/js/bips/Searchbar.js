import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

const html = htm.bind(h);

import { Search } from 'lucide-preact';

const Searchbar = ({
    onChange,
    defaultValue='',
    ...props}) => {

    return html`
        <div class="bip-searchbar-container">
            <input
                type="input"
                defaultValue=${defaultValue}
                class="bip-searchbar" onChange=${onChange} ...${props} />
            <${Search} class="bip-searchbar-icon"/>
        </div>
    `;
};

export default Searchbar;