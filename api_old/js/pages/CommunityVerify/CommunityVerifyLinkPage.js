import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import BasicPageLayout from '../BasicPageLayout.js';
import Alert from '../../bips/Alert.js';

const CommunityVerifyLinkPage = ({slug}) => {

    let [error, setError] = useState(null);
    let { url, path, query, route } = useLocation();
    console.dir(slug);
    console.dir(query);


    useEffect(async () => {
        let user_id = query['user_id'];
        let code = query['code'];

        if(!user_id || !code){
            setError("Invalid verification link.");
            return;
        }

        // here:
        try{
            await Data.verify.verifyEmailVerificationCode({slug, user_id, code});
        }
        catch(err){
            if(err.message.includes("Failed to deserialize")){
                setError("Something about that verification link was invalid!");
            }
            else{
                setError(err.message);
            }
            return;
        }

        // if that worked, redirect to
        route(`/community/${slug}/verify`);

    }, []);

    return html`
    <${BasicPageLayout} title="Verify Your Email">

        <${Alert} variant="error" message=${error} />
    </div>
    `;
}

export default CommunityVerifyLinkPage;