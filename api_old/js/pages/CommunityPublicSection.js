import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import Button from '../bips/Button.js';
import CommunityWidget from '../widgets/CommunityWidget/CommunityWidget.js';

const CommunityPublicSection = ({slug}) => {

    let { route } = useLocation();

    useEffect(() => {
        document.title = slug;
    }, []);

    return html`
    <div class="community-public-blob">

        <${CommunityWidget} slug=${slug} />

        <${Button} onClick=${() => route(`/community/${slug}/login`)}>Login<//>

    </div>
    `;
        /*
        <${Button} onClick=${() => route(`/community/${slug}/login?type=email-pass`)}>Login With Email And Password<//>
        <br/>
        <${Button} onClick=${() => route(`/community/${slug}/login?type=email`)}>Login With Email<//>
        <br/>
        <${Button} onClick=${() => route(`/community/${slug}/login?type=phone-pass`)}>Login With Phone Number And Password<//>
        <br/>
        <${Button} onClick=${() => route(`/community/${slug}/login?type=phone`)}>Login With Phone Number<//>
        */
}

export default CommunityPublicSection;