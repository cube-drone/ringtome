import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import sha256 from '../sha256';

const html = htm.bind(h);

const Gravatar = ({hashable, overrideSha, defaultType="retro", title}) => {
    // uh, I guess it's actually a privacy issue to USE this for the user's email,
    // on account of the email shouldn't be accessible from the client side
    // shit.
    // okay, I'll have to have the server generate the email's sha256 hash instead
    // valid defaultTypes include "retro", "identicon", "monsterid", "wavatar", "robohash", "mp"

    let [sha, setSha] = useState(overrideSha);

    useEffect(() => {
        const computeSha = async () => {
            if(overrideSha){
                return;
            }
            if(!hashable){
                return;
            }
            let sha256_ip = await sha256(hashable);
            setSha(sha256_ip);
        };
        computeSha();
    }, [hashable]);

    return html`
        ${sha && html`<img class="gravatar" src="https://gravatar.com/avatar/${sha}?d=${defaultType}" alt="${title}" title=${title} />`}
    `;
};

export default Gravatar;