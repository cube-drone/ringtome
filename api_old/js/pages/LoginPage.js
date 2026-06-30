import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import Input from '../bips/Input.js';
import Button from '../bips/Button.js';

import BasicPageLayout from './BasicPageLayout.js';
import Alert from '../bips/Alert.js';

const LoginPage = ({slug}) => {

    let [error, setError] = useState(null);
    let { url, path, query, route } = useLocation();
    let [buttonLoading, setButtonLoading] = useState(false);
    let [forgotPassword, setForgotPassword] = useState(false);

    useEffect(async () => {
        try{
            // check if logged in
            let session = await window.Data.session.getSession({slug});
            if(session){
                console.warn("already logged in!");
                route(`/community/${slug}`);
            }
        } catch(e){

        }
    }, []);

    const formSubmit = async (e) => {
        setButtonLoading(true);
        e.preventDefault();
        let form = e.target.closest("form");
        let formData = new FormData(form);
        setError(null);

        let data = {};
        for (let key of formData.keys()) {
            data[key] = formData.get(key);
        }

        let login = {
            password: data['password'],
            token: data['token'],
        };

        if(data['email_or_phone']){
            let email_or_phone = data['email_or_phone'];
            if(email_or_phone.includes('@')){
                login.email = email_or_phone;
            } else {
                login.phone_number = email_or_phone;
            }
        }

        try{
            if(login.token){
                if(!query.user_id){
                    throw new Error("No user_id provided");
                }
                await window.Data.session.loginTokenComplete({slug, user_id: query.user_id, ...login});

                // if that worked, redirect to the dashboard
                route(`/community/${slug}`);
            }
            else if(login.password){
                let resp = await window.Data.session.login({slug, ...login});
                if(!resp){
                    throw new Error("Authentication failed.");
                }
                if(resp.error){
                    throw new Error(resp.error);
                }

                // if that worked, redirect to the dashboard
                route(`/community/${slug}`);
            }
            else{
                let resp = await window.Data.session.loginToken({slug, ...login});

                if(resp.error){
                    throw new Error(resp.error);
                }

                let userId = resp.user_id ?? resp.userId;

                // if that worked, redirect to the login-complete-with-a-token page
                if(login.email){
                    route(`/community/${slug}/login?type=token-email&user_id=${userId}`);
                }
                else{
                    route(`/community/${slug}/login?type=token-phone&user_id=${userId}`);
                }
            }
        }
        catch(e){
            setError(e.message);
        }
        finally {
            setButtonLoading(false);
        }
    }

    let type = query.type ?? "default";
    let form = null;
    switch (type){
        case 'token-email': {
            form = html`
            <p>
                A token has been sent to your email! Please enter it below to login.
            </p>
            <form onSubmit=${formSubmit}>
                <${Input}
                    id="token"
                    name="token"
                    type="text"
                    label="Token"
                    minlength="1"
                    hideHelpText
                    required/>
                <br/>
                <${Button} loading=${buttonLoading} type="submit">Login<//>
            </form>`;
            break;
        }
        case 'token-phone': {
            form = html`
            <p>
                A token has been sent to your phone! Please enter it below to login.
            </p>
            <form onSubmit=${formSubmit}>
                <${Input}
                    id="token"
                    name="token"
                    type="text"
                    label="Token"
                    minlength="1"
                    hideHelpText
                    required/>
                <br/>
                <${Button} loading=${buttonLoading} type="submit" variant="primary">Login<//>
            </form>`;
            break;
        }
        case "default": {
            form = html`
            <form onSubmit=${formSubmit}>
                <${Input}
                    id="email_or_phone"
                    name="email_or_phone"
                    type="email_or_tel"
                    label="Email or Phone Number"
                    placeholder="beefs@cheese.corn or 555-555-5555"
                    minlength="1"
                    hideHelpText
                    required/>
                <br/>
                ${forgotPassword ?
                    html`<p>No worries! Just enter your email or phone number above and we'll send you a login token.</p>` :
                    html`<${Input}
                        type="password"
                        id="password"
                        name="password"
                        label="Password"
                        minlength="8"
                        hideHelpText
                        required/>
                    <br/>`
                }
                <${Button} loading=${buttonLoading} type="submit" variant="primary">Login<//>
                ${forgotPassword ? null : html`
                    <${Button} loading=${buttonLoading} onClick=${(e) => {e.preventDefault(); setForgotPassword(true);}} variant="secondary">Forgot Password?<//>
                `}
            </form>`;
            break;
        }
        default:{
            break;
        }
    }

    return html`
    <${BasicPageLayout} title="Login">
        ${form}
        <br/>
        <br/>
        <${Alert} message=${error} />
    </div>
    `;
}

export default LoginPage;