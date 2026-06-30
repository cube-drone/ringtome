import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import CommunityHomePageLayout from './CommunityHomePageLayout.js';
import Alert from '../../bips/Alert.js';
import User from '../../widgets/User/User.js';

const CommunityUsersPage = ({slug, userSlug}) => {

    let [error, setError] = useState(null);
    let [session, setSession] = useState(null);
    let [user, setUser] = useState(null);
    let [loading, setLoading] = useState(true);
    let { url, path, query, route } = useLocation();

    useEffect(() => {
        // Fetch users from the API
        const fetchUsers = async () => {
            try {
                let session = await window.Data.session.getSession({slug});
                setSession(session);
                let user = await window.Data.user.getUserBySlug({slug, userSlug});
                setUser(user);
            } catch (e) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        };
        fetchUsers();
    }, []);

    const userHasChanged = async() => {
        try {
            let user = await window.Data.user.getUserBySlug({slug, userSlug});
            setUser(user);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }

    return html`
    <${CommunityHomePageLayout} loading=${loading} slug=${slug} pageName=${user?.name || "User" }>
        <h2><small><a href="/community/${slug}/users/">Users</a></small> / ${user ? user.name : ''}</h2>

        <${Alert} type="error" message=${error} />

        ${user ? html`<${User}
            user=${user}
            communitySlug=${slug}
            onUserChange=${userHasChanged}
            isMe=${user.user_id === session.user_id}
            isAdmin=${session.is_admin}
            />` : null}
    <//>
    `;
}

export default CommunityUsersPage;