
import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import Button from '../../bips/Button.js';
import Input from '../../bips/Input.js';
import Alert from '../../bips/Alert.js';

const CommunityEmailVerifyForm = ({slug, session, onComplete}) => {

    let [error, setError] = useState(null);
    let [retryButtonLoading, setRetryButtonLoading] = useState(false);
    let [hideRetryButton, setHideRetryButton] = useState(false);
    let [verifyButtonLoading, setVerifyButtonLoading] = useState(false);
    let { url, path, query, route } = useLocation();
    let [numFailures, setNumFailures] = useState(-1);

    if(!onComplete || typeof onComplete != 'function'){
        onComplete = () => {};
    }

    useEffect(async () => {
        try{
            // send the SMS verification code
            await window.Data.verify.sendEmailVerificationCode({slug});
        }
        catch(e){
            setError(e.message);
        }
    }, []);

    const retry = async (e) => {
        e.preventDefault();
        setRetryButtonLoading(true);
        try{
            // send the SMS verification code
            await window.Data.verify.sendEmailVerificationCode({slug});
            setError("My email provider's reputation is terrible ever since I did all of those crimes, so you might need to check for the email in your spam folder.");
            setHideRetryButton(true);
        }
        catch(e){
            setError(e.message);
        }
        finally {
            setRetryButtonLoading(false);
        }
    }

    const formSubmit = async (e) => {
        setVerifyButtonLoading(true);
        e.preventDefault();

        let form = e.target;
        let formData = new FormData(form);
        let data = {};
        for (let key of formData.keys()) {
            data[key] = formData.get(key);
        }
        console.dir(data['code']);
        if(!data['code']){
            setError("Please enter the verification code.");
            return;
        }
        if(data['code'].length != 6){
            setError("Please enter a 6-digit verification code.");
            return;
        }

        try{
            await Data.verify.verifyEmailVerificationCode({slug, user_id: session?.user_id, code: data['code']});

            // if that worked, then we're done
            await onComplete();
        }
        catch(e){
            console.error(e);
            setNumFailures(numFailures + 1);
            setError(e.message);
            return;
        }
        finally{
            setVerifyButtonLoading(false);
        }
    }

    let still = "";
    if(numFailures > 0){
        still = "still ".repeat(numFailures);
    }

    return html`
    <div class="community-email-verify-form">
        <h3>Email Verification</h3>

        <p> A verification code has been sent to your <strong>email</strong>. Please enter the code below to verify your account. </p>
        <form onSubmit=${formSubmit}>
            <${Input} name="code" label="Verification Code" type="vercode" required />
            <br />
            <${Alert} variant="error" message=${error} />
            <${Button} type="submit" variant="primary" loading=${verifyButtonLoading}>Verify<//>
            ${!hideRetryButton ?
                html`<${Button} onClick=${retry} loading=${retryButtonLoading}>Send Another Code<//>`
                : null
            }
        </form>
    </div>
    `;
}

export default CommunityEmailVerifyForm;