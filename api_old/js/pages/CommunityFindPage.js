import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';
import CommunityWidget from '../widgets/CommunityWidget/CommunityWidget.js';

import Alert from '../bips/Alert.js';
import Button from '../bips/Button.js';
import Searchbar from '../bips/Searchbar.js';


export default CommunityFindPage = () => {
    // type in a community name, it will try to autocomplete to an existing community
    // communities can opt out of being found in the "find community" page

    let [communities, setCommunities] = useState([]);
    let [search, setSearch] = useState('');
    let [error, setError] = useState(null);
    let [loading, setLoading] = useState(true);
    let [noMore, setNoMore] = useState(false);

    // when we boot, load all communities
    useEffect(async () => {
        document.title = "Find";
        let activeCommunities = await window.Data.community.getActiveCommunities({n: 5});
        let communitySlugs = activeCommunities.map(community => community.community_slug);

        let communities = await Promise.all(communitySlugs.map(async (community_slug) => {
            let community = await window.Data.community.getCommunity({slug: community_slug});
            return community;
        }));

        // filter out communities that are not found
        communities = communities.filter(community => community != null);
        // filter out communities that don't contain the search term
        communities = communities.filter(community => community.community_name.toLowerCase().includes(search.toLowerCase()));

        // remove communities that don't match the search
        //communities = communities.filter(community => community.community_name.toLowerCase().includes(search.toLowerCase()));
        try {
            let resp = await window.Data.community.listCommunities({prefix: search, n: 12});
            // remove communities that are already in the list
            resp = resp.filter(community => !communities.some(c => c.community_slug === community.community_slug));
            setNoMore(resp.length == 0);
            setCommunities([...communities, ...resp]);
            setLoading(false);
        } catch (e) {
            setError(e.message);
            setLoading(false);
        }
    }, [search]);

    const loadMoreCommunities = async () => {
        try {
            let resp = await window.Data.community.listCommunities({prefix: search, offset: communities.length});
            if(resp.length == 0){
                setNoMore(true);
            }
            else{
                setCommunities(communities.concat(resp));
            }
        } catch (e) {
            setError(e.message);
        }
    };

    return html`
    <${BasicPageLayout} loading=${loading && communities} title="Find Community">
        <div class="community-search-bar">
            <${Searchbar} onChange=${(e) => setSearch(e.target.value)} defaultValue=${search} />
            <${Alert} message=${error} />
        </div>
        <hr />

        <${Alert} message=${communities.length == 0 ? "no communities found" : ""} variant="null" />
        ${communities?.map(community => {
            return html`
                <${CommunityWidget} slug=${community.community_slug} />
            `;
        })}
        ${communities?.length > 0 && !noMore ? html`
            <${Button} onClick=${loadMoreCommunities} class="load-more-button" variant="primary" size="large">
                Load more
            <//>` : ''
        }

    </div>
    `;
}