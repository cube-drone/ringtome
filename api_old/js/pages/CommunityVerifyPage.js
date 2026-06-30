import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';
import CommunitySMSVerifyForm from './CommunityVerify/CommunitySMSVerifyForm.js';
import CommunityEmailVerifyForm from './CommunityVerify/CommunityEmailVerifyForm.js';

const CommunityVerifyPage = ({slug}) => {

    let [session, setSession] = useState(null);
    let [phone_needs_verified, setPhoneNeedsVerified] = useState(false);
    let [email_needs_verified, setEmailNeedsVerified] = useState(false);
    let { url, path, query, route } = useLocation();

    const whatVerificationIsNeeded = async () => {
        try{
            let session = await window.Data.session.getSession({slug, reload:true});
            if(!session){
                route('/');
            }
            console.dir(session);
            setSession(session);

            if(session.user_tags.includes("has_phone") && !session.user_tags.includes("phone_verified")){
                console.log("phone needs verified");
                setPhoneNeedsVerified(true);
            }
            else{
                setPhoneNeedsVerified(false);
            }

            if(session.user_tags.includes("has_email") && !session.user_tags.includes("email_verified")){
                console.log("email needs verified");
                setEmailNeedsVerified(true);
            }
            else{
                setEmailNeedsVerified(false);
            }
        }
        catch(e){
            console.error(e);
            route('/');
        }

    }

    // useEffect to grab the current session from window.Data and redirect if not logged in
    useEffect(async () => {
        await whatVerificationIsNeeded();
    }, []);

    const refresh = async () => {
        await whatVerificationIsNeeded();
    }

    if(!session){
        // go home if no session
        return html`<${BasicPageLayout} title="Loading..."></${BasicPageLayout}>`;
    }

    let content;
    if(phone_needs_verified){
        content = html`<${CommunitySMSVerifyForm} slug=${slug} session=${session} onComplete=${refresh} />`;
    }
    else if (email_needs_verified){
        content = html`<${CommunityEmailVerifyForm} slug=${slug} session=${session} onComplete=${refresh} />`;
    }
    else{
        content = html`<div>
            <h3>Verification Complete</h3>
            <p> Your account has been verified. </p>

            <a href="/community/${slug}">Finally!</a>
        </div>`;
    }

    return html`
    <${BasicPageLayout} title=${session.community_name}>
        ${content}
    </div>
    `;
}

export default CommunityVerifyPage;