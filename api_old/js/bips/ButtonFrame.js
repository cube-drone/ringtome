import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

const html = htm.bind(h);

import Button from './Button.js';


const ButtonFrame = ({type, variant="default", loading, onClick, label, children, ...props}) => {
    /*
    This component is a wrapper for a button that allows you to add additional content
    around the button, such as an icon or text. It is useful for creating more complex
    button layouts.
    */

    let disabledStyle = '';
    if(props.disabled){
        disabledStyle = 'bip-button-disabled';
    }

    return html`
        <div class="bip-button-frame bip-button-frame-${variant} ${disabledStyle}">
            <!-- describe what this button does -->
            <div class="bip-button-frame-description">
                ${children}
            </div>
            <${Button} bottom type=${type} variant=${variant} loading=${loading} onClick=${onClick} ...${props}>
                ${label}
            <//>
        </div>
    `;
};

export default ButtonFrame;