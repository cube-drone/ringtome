import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import Button from '../bips/Button.js';
import Input from '../bips/Input.js';
import Checkbox from '../bips/Checkbox.js';

import BasicPageLayout from './BasicPageLayout.js';
import Alert from '../bips/Alert.js';

const CommunityCreatePage = () => {

    let [error, setError] = useState(null);
    let [complete, setComplete] = useState(false);
    let { url, path, query, route } = useLocation();
    let [buttonLoading, setButtonLoading] = useState(false);

    useEffect(() => {
        document.title = "Create Community";
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
        /*
            #[validate(length(min = 1, max = 100))]
            pub community_name: String,
            #[validate(length(min = 1))]
            pub name: String,
            #[validate(length(min = 8, max = 100))]
            pub password: Option<String>,
            #[validate(length(min = 1), email)]
            pub email: Option<String>,
            #[validate(length(min = 7), regex(path = *RE_PHONE_NUMBER))]
            pub phone_number: String,
            pub tos: bool,
        */
        let email = data['community-email'];
        if(email == "" || email.trim() == ""){
            email = null;
        }
        let phone_number = data['community-phone'];
        if(phone_number == "" || phone_number.trim() == ""){
            phone_number = null;
        }

        let community = {
            community_name: data['community-name'],
            name: data['owner-name'],
            email,
            phone_number,
            password: data['community-password'],
            tos: data['community-terms'] == "on",
        }
        console.dir(community);

        try {
            let created_community = await window.Data.community.createCommunity(community);
            route(`/community/${created_community.community_slug}/verify`);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setButtonLoading(false);
        }
    }

    const formTest = (e) => {
        console.log("formTest", e);
        // e is a child of the form
        let form = e.target.closest("form");
        let formData = new FormData(form);
        let data = {};
        for (let key of formData.keys()) {
            data[key] = formData.get(key);
        }

        let community = {
            community_name: data['community-name'],
            name: data['owner-name'],
            email: data['community-email'],
            phone_number: data['community-phone'],
            password: data['community-password'],
            tos: data['community-terms'] == "on",
        }
        console.dir(community);

        if(!community.tos || !community.community_name || !community.name || !community.password){
            setComplete(false);
            return;
        }

        if(community.password.length < 8){
            setComplete(false);
            return;
        }
        // we need either an email or a phone number
        if(!community.email && !community.phone_number){
            setComplete(false);
            return;
        }

        if(community.phone_number){
            if(community.phone_number.length < 9){
                setComplete(false);
                return;
            }

            // if community phone number contains anything other than numbers, spaces, or dashes
            if(!community.phone_number.match(/^[0-9 +-]+$/)){
                setComplete(false);
                return;
            }
        }
        if(community.email){
            if(!community.email.includes("@") || !community.email.includes(".")){
                setComplete(false);
                return;
            }
        }


        setComplete(true);
    }

    return html`
    <${BasicPageLayout} title="Create">

        <form onSubmit=${formSubmit}>
            <${Input}
                id="community-name"
                name="community-name"
                label="Community Name"
                placeholder="Very Good Hat Community"
                helpText="This is the name of your community"
                successText="That's a pretty good community name!"
                onChange=${formTest}
                required/>
            <br/>
            <${Input}
                id="owner-name"
                name="owner-name"
                label="Community Manager Name"
                placeholder="Owen R."
                helpText="This is your name! You'll manage the community's account."
                successText="I like your name!"
                onChange=${formTest}
                required/>
            <br/>
            <${Input}
                type="password"
                id="community-password"
                name="community-password"
                label="Community Password"
                helpText="This password will be used to log in to your community account"
                onChange=${formTest}
                required/>
            <br/>
            <${Checkbox}
                id="community-terms"
                name="community-terms"
                onChange=${formTest}
                required>
                    I have read and agree to the <a href="/home/terms">terms and conditions</a>.
                <//>
            <h2> Accounts Must Have an Email <em>or</em> Phone Number </h2>
            <${Input}
                type="email"
                id="community-email"
                name="community-email"
                label="Email"
                placeholder="hats@verygood.co"
                helpText="A verification email will be sent to this address"
                onChange=${formTest}
                />
            <br/>
            <${Input}
                type="tel"
                id="community-phone"
                name="community-phone"
                label="Phone"
                placeholder="1-604-555-1234"
                helpText="A verification SMS will be sent to this number"
                onChange=${formTest}
                />
            <br/>

            <${Alert} message=${error} />

            <${Button} loading=${buttonLoading} type="submit" variant="primary" disabled=${!complete}>Create Community<//>
        </form>
    </div>
    `;
}

export default CommunityCreatePage;