import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import CommunityHomePageLayout from './CommunityHomePageLayout.js';
import Alert from '../../bips/Alert.js';
import Searchbar from '../../bips/Searchbar.js';
import User from '../../widgets/User/User.js';

const CommunityUsersPage = ({slug}) => {

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
                let user = await window.Data.user.getUser({slug, userId: session.user_id});
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
        setLoading(true);
        try {
            let user = await window.Data.user.getUser({slug, userId: session.user_id});
            setUser(user);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }

    return html`
    <${CommunityHomePageLayout} loading=${loading} slug=${slug} pageName="Profile">
        <h2>Profile</h2>

        <${Alert} type="error" message=${error} />

        ${user ? html`<${User} user=${user} communitySlug=${slug} onUserChange=${userHasChanged} isMe=${true} isAdmin=${session.is_admin} />` : null}
    <//>
    `;
}

export default CommunityUsersPage;