import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import Gravatar from '../../bips/Gravatar.js';

const html = htm.bind(h);

const UserSpan = ({slug, userId, isMe}) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchUser = async () => {
            try {
                let userData = await window.Data.user.getUser({slug, userId});
                setUser(userData);
            } catch (e) {
                console.error("Error fetching user:", e.message);
            } finally {
                setLoading(false);
            }
        };
        fetchUser();
    }, [userId]);

    let gravatar = null;
    if(user){
        gravatar = html`<${Gravatar} hashable=${user.id} overrideSha=${user.email} defaultType="wavatar" title=${user.name} />`;
        if(isMe){
            gravatar = html`<${Gravatar} hashable=${user.email} defaultType="wavatar" title=${user.name} />`;
        }
    }

    if(loading){
        return html`<span>Loading...</span>`;
    }
    if(!user){
        return html`<span>${userId}</span>`;
    }

    return html`
    <span class="user-span">
        <span class="user-gravatar">
            ${gravatar}
        </span>
        <a href="/community/${slug}/users/${user.slug}">${user.name}</a>
    </span>`;
}

export default UserSpan;