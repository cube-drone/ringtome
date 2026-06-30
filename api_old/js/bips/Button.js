import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

const html = htm.bind(h);

import Loading from './Loading';

const Button = ({variant="default", onClick, children, loading, bottom, ...props}) => {

    let disabledStyle = '';
    if(props.disabled){
        disabledStyle = 'bip-button-disabled';
    }
    let loadingStyle = '';
    if(loading){
        loadingStyle = 'bip-button-loading';
    }
    let bottomStyle = '';
    if(bottom){
        bottomStyle = ' bip-button-bottom';
    }

    const onClickHandler = (e) => {
        if (props.disabled || loading) {
            e.preventDefault();
            return;
        }
        if (onClick) {
            onClick(e);
        }
    };

    return html`
        <button class="bip-button bip-button-${variant} ${disabledStyle} ${loadingStyle}" onClick=${onClickHandler} ...${props}>
            ${loading
                ? html`
                    <span class="bip-button-placeholder">${children} <!-- this is what keeps the button the same size when loading --></span>
                    <${Loading} size=${12} strokeWidth=${4} />
                `
                : children
            }
        </button>
    `;
};

export default Button;