import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';
import CommunityHomePageLayout from './Community/CommunityHomePageLayout.js';
import CommunityPublicSection from './CommunityPublicSection.js';
import CommunityHomeSection from './Community/CommunityHomeSection.js';

const CommunityPage = ({slug}) => {

    let [error, setError] = useState(null);
    let [loading, setLoading] = useState(true);
    let [session, setSession] = useState(null);
    let [community, setCommunity] = useState(null);
    let { url, path, query, route } = useLocation();

    useEffect(async () => {
        let session, community;
        try{
            // check if logged in
            session = await window.Data.session.getSession({slug});
            setSession(session);
        } catch(e){
            console.error("Error getting session:", e);
        }
        try{
            // get community info
            community = await window.Data.community.getCommunity({slug});
            setCommunity(community);
        }
        catch(e){
            console.error("Error getting community:", e);
            setError(e.message);
        }

        if(community && session){
            // we're logged in and have community info! That's good!
            await window.Data.community.addActiveCommunity({community_slug: slug})
        }

        setLoading(false);
    }, []);

    if(session){
        return html`
        <${CommunityHomePageLayout} loading=${loading} slug=${slug} session=${session}>
            <${CommunityHomeSection} slug=${slug} session=${session} community_name=${community ? community.community_name : "Community"} />
        <//>
        `;
    } else {
        return html`
        <${BasicPageLayout} loading=${loading} title="${community ? community.community_name : 'Community'}">
            <${CommunityPublicSection} slug=${slug} community_name=${community ? community.community_name : "Community"} />
        <//>
        `
    }
}

export default CommunityPage;