import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import Button from '../bips/Button.js';
import Checkbox from '../bips/Checkbox.js';
import Input from '../bips/Input.js';

import BasicPageLayout from './BasicPageLayout.js';
import Alert from '../bips/Alert.js';

const UserRegistrationPage = ({slug, id}) => {

    // this page looks different: if we're already logged in, just show the invite code
    // if we're not logged in, show the registration form with the invite code prefilled

    let [session, setSession] = useState(null);
    let [community, setCommunity] = useState(null);
    let [error, setError] = useState(null);
    let [complete, setComplete] = useState(false);
    let [loading, setLoading] = useState(true);
    let [buttonLoading, setButtonLoading] = useState(false);
    let { url, path, query, route } = useLocation();

    useEffect(async () => {
        try{
            // check if logged in
            let session = await window.Data.session.getSession({slug});
            setSession(session);
        } catch(e){

        }
        try{
            // get community info
            let community = await window.Data.community.getCommunity({slug});
            setCommunity(community);
        }
        catch(e){
            setError(e.message);
        }
        setLoading(false);
    }, []);

    const formSubmit = async (e) => {
        setButtonLoading(true);
        e.preventDefault();

        let form = e.target;
        let formData = new FormData(form);
        let data = {};
        for (let key of formData.keys()) {
            data[key] = formData.get(key);
        }
        console.dir(data);

        let user = {
            name: data['employee-name'],
            email: data['user-email'] || null,
            phone_number: data['user-phone'] || null,
            password: data['user-password'],
            tos: data['community-terms'] == "on",
        }
        console.dir(user);
        console.warn("user", user.name);

        try {
            let invite_code = data['invite-code'];
            let created_user = await window.Data.user.createUser({slug, user, invite_code});
            route(`/community/${slug}/verify`);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setButtonLoading(false);
        }
    }

    const formTest = (e) => {
        // e is a child of the form
        let form = e.target.closest("form");
        let formData = new FormData(form);
        let data = {};
        for (let key of formData.keys()) {
            data[key] = formData.get(key);
        }

        console.dir(data);

        let user = {
            invite_code: data['invite-code'],
            employee_name: data['employee-name'].trim(),
            email: data['user-email'].trim(),
            phone_number: data['user-phone'].trim(),
            password: data['user-password'].trim(),
            tos: data['community-terms'] == "on",
        }

        console.dir(user);

        if(!user.tos || !user.invite_code || !user.employee_name){
            console.log("tos, invite_code, and employee_name are required");
            setComplete(false);
            return;
        }

        if(user.password && user.password.length < 8){
            console.log("password is too short");
            setComplete(false);
            return;
        }

        if(!user.phone_number && !user.email && !user.password){
            // need at least one of these
            console.log("need at least one of phone number, email, or password");
            setComplete(false);
            return;
        }

        if(user.phone_number && user.phone_number.length < 9){
            console.log("phone number is too short");
            setComplete(false);
            return;
        }

        if(user.name && user.name.length < 2){
            console.log("name is too short");
            setComplete(false);
            return;
        }

        // if user phone number contains anything other than numbers, spaces, or dashes
        if(user.phone_number && !user.phone_number.match(/^[0-9 +-]+$/)){
            console.log("phone number is numeric only");
            setComplete(false);
            return;
        }

        if(user.email && user.email.length > 0 && (!user.email.includes("@") || !user.email.includes("."))){
            setComplete(false);
            return;
        }

        setComplete(true);
    }

    if(session){
        let linkTarget = `/community/${slug}/invite/${id}`;
        let fullLinkTarget = `${window.location.origin}${linkTarget}`;
        return html`
        <${BasicPageLayout} title="Registration Code">
            <h2>${id}</h2>
            <p>An employee needs this link to create an account</p>
            <p>
                <a href="${linkTarget}" target="_blank">
                    ${fullLinkTarget}
                </a>
            </p>
            <${Button} onClick=${() => { navigator.clipboard.writeText(fullLinkTarget); } }> Copy Link to Clipboard </${Button}>
        <//>
        `;
    }

    return html`
    <${BasicPageLayout} loading=${loading} title="User Registration">

        <form onSubmit=${formSubmit}>
            <input type="hidden" id="invite-code" name="invite-code" value="${id}" />
            <${Input}
                id="employee-name"
                name="employee-name"
                label="Employee Name"
                placeholder="Em P. Lloyd"
                helpText="This is your name!"
                onChange=${formTest}
                required/>
            <br/>
            <${Input}
                type="email"
                id="user-email"
                name="user-email"
                label="Email (Optional)"
                placeholder="email@verygood.co"
                helpText="A verification email will be sent to this address. (You don't have to, but it's helpful if you forget your password)"
                onChange=${formTest}
                />
            <br/>
            <${Input}
                type="tel"
                id="user-phone"
                name="user-phone"
                label="Phone Number (Optional)"
                placeholder="1-604-555-1234"
                minlength="10"
                helpText="A verification SMS will be sent to this number. (You don't have to, but it's helpful if you forget your password)"
                onChange=${formTest}
                />
            <br/>
            <${Input}
                type="password"
                id="user-password"
                name="user-password"
                label="User Password"
                minlength="8"
                help-text="This password will be used to log in to your community account"
                onChange=${formTest}
                />
            <br/>
            <${Checkbox}
                id="community-terms"
                name="community-terms"
                onChange=${formTest}
                required>
                    I have read and agree to the <a href="/home/terms" onClick=${()=>{route('/home/terms')}}>terms and conditions</a>.
                <//>

            <${Alert} message=${error} />

            <${Button} loading=${buttonLoading} type="submit" variant="primary" disabled=${!complete}>Create User Account<//>
        </form>
    </div>
    `;
}

export default UserRegistrationPage;