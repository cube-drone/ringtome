import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import { useLocation } from 'preact-iso';

import htm from 'htm';

const html = htm.bind(h);

const CommunityWidget = ({slug}) => {

    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [community, setCommunity] = useState(null);
    const [loggedIn, setLoggedIn] = useState(false);

    let { url, path, query, route } = useLocation();

    useEffect(async () => {
        try {
            // Fetch community data
            let community = await window.Data.community.getCommunity({slug});
            setCommunity(community);
        } catch (e) {
            setError(e.message);
        }
        setLoading(false);

        try{
            // touch is true if community isn't in the path
            let touch = !path.includes(`/community/${slug}`);
            // Check if we're logged in to this community
            let session = await window.Data.session.getSession({slug, touch});
            if (session) {
                setLoggedIn(true);
            }
            else{
                setLoggedIn(false);
            }
        }
        catch(e){
            if(e.message.includes("not valid") || e.message.includes("found")){
                // If the session is not valid or not found, we are not logged in
            }
            else{
                console.error("Error checking session:", e.message);
            }
            setLoggedIn(false);
        }

    }, [slug]);

    // we only want to link to the community IF we are not currently already on the community page
    const isCurrentCommunityPage = url.includes(`/community/${slug}`);
    let communityLink = null;
    if (community && !isCurrentCommunityPage) {
        communityLink = html`<a href="/community/${community.community_slug}">${community.community_name}</a>`;
    }
    else if (community) {
        communityLink = html`<span>${community.community_name}</span>`;
    }

    return html`
    <div class="community-widget ${loggedIn ? 'logged-in' : ''}">
        ${loading ? html`<p>Loading...</p>` : ''}
        ${error ? html`<p class="error">${error}</p>` : ''}
        ${community ? html`
            <h3>${communityLink}</h3>
        ` : ''}
    </div>
    `;
}

export default CommunityWidget;