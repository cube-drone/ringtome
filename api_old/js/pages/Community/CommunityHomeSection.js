import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import CommunityWidget from '../../widgets/CommunityWidget/CommunityWidget.js';

import Button from '../../bips/Button.js';

const CommunityHomeSection = ({slug, session, community_name}) => {

    let [error, setError] = useState(null);
    let { url, path, query, route } = useLocation();

    /*
        you're logged in, so you can see ... stuff!
    */
    const trafficForm = (e) => {
        e.preventDefault();
        route(`/community/${slug}/mountain_view/traffic_control_form`);
    };

    return html`
    <${CommunityWidget} slug=${slug} />
    <hr/>
    <div class="community-public-blob">
        <p> Hi, <strong>${session.user_name}</strong>! </p>

    </div>
    `;
}

export default CommunityHomeSection;