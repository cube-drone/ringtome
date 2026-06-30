import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import { ChevronDown, CircleChevronDown } from 'lucide-preact';

const html = htm.bind(h);

const Collapsibro = ({title, variant="default", start="closed", visible, children, ...props}) => {

    let [isOpen, setIsOpen] = useState(start === "open");

    const toggleOpen = () => {
        setIsOpen(!isOpen);
    }

    if(visible === false){
        return null;
    }

    return html`
        <div class="bip-collapsibro bip-collapsibro-${variant}" ...${props}>
            <a class="bip-collapsibro-title" onClick=${toggleOpen}>
                ${isOpen ? html`<${ChevronDown} />` : html`<${CircleChevronDown} />`}
                <span class="bip-collapsibro-title-text">${title}</span>
            </a>
            <div class="bip-collapsibro-content" style="display: ${isOpen ? 'block' : 'none'};">${children}</div>
        </div>
    `;
};

export default Collapsibro;