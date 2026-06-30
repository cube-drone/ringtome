import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import CommunityHomePageLayout from './CommunityHomePageLayout.js';
import CommunitySettings from '../../widgets/CommunitySettings/CommunitySettings.js';
import Alert from '../../bips/Alert.js';

const CommunityAdminPage = ({slug}) => {

    let [error, setError] = useState(null);
    let [session, setSession] = useState(null);
    let [loading, setLoading] = useState(true);
    let { url, path, query, route } = useLocation();

    useEffect(() => {
        // Fetch users from the API
        const fetchSession = async () => {
            try {
                console.dir(query);

                let session = await window.Data.session.getSession({slug});
                setSession(session);
                if(!session || !session.is_admin){
                    route(`/community/${slug}`);
                }
            } catch (e) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        };
        fetchSession();
    }, []);

    return html`
    <${CommunityHomePageLayout} loading=${loading} slug=${slug} pageName="Admin">
        <h2>Admin</h2>

        <${Alert} type="error" message=${error} />

        <${CommunitySettings} slug=${slug} session=${session} />

    <//>
    `;
}

export default CommunityAdminPage;