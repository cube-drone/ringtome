import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

const html = htm.bind(h);

const Flexstack = ({children, reverse=false, ...props}) => {

    let styleClass = "bip-flexstack";
    if(reverse){
        styleClass = "bip-flexstack-reverse";
    }

    let disabledStyle = '';
    if(props.disabled){
        disabledStyle = 'bip-button-disabled';
    }


    return html`
        <div class="${styleClass} ${disabledStyle}">
            ${children}
        </div>
    `;
};

export default Flexstack;