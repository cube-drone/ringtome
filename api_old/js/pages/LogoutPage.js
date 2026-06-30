import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';
import Button from '../bips/Button.js';

const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';
import Alert from '../bips/Alert.js';

const LogoutPage = ({slug}) => {

    let [error, setError] = useState(null);
    let { url, path, query, route } = useLocation();

    useEffect(async () => {
        try {
            await window.Data.session.logout({slug});
            route(`/community/${slug}`);
        }
        catch(e){
            console.warn("this happened");
            setError(`${e.message} - but that's probably fine, it just means you're already logged out.`);
        }

    }, []);

    return html`
    <${BasicPageLayout} title="Logout">
        <${Button} onClick=${() => route(`/community/${slug}`)}>Home<//>
        <br/>
        <br/>
        <${Alert} error=${error} />

    </div>
    `;
}

export default LogoutPage;