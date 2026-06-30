import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

const html = htm.bind(h);

const Checkbox = ({variant, onChange, children, ...props}) => {

    let disabledStyle = '';
    if(props.disabled){
        disabledStyle = 'bip-checkbox-disabled';
    }

    if(props.id == null){
        // Generate an ID from the children text
        if(typeof children !== 'string'){
            props.id = children.replace(/\s+/g, '-').toLowerCase();
        }
    }

    if(props.label == null){
        // Generate a label from the children text
        props.label = children;
    }

    return html`
        <div class="bip-checkbox-group">
            <input type="checkbox" class="bip-checkbox bip-checkbox-${variant} ${disabledStyle}" onChange=${onChange} ...${props} />
            <label for=${props.id} class="bip-checkbox-label bip-checkbox-label-${variant} ${disabledStyle}">
                ${props.label}
            </label>
            ${props.description && html`<p class="bip-checkbox-description">${props.description}</p>`}
        </div>
    `;
};

export default Checkbox;