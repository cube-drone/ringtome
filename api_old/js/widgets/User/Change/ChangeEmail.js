import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import Input from '../../../bips/Input.js';
import Button from '../../../bips/Button.js';
import Alert from '../../../bips/Alert.js';

import { useToast } from '../../../bips/Toast/ToastContext.js';

const html = htm.bind(h);

const ChangeEmail = ({
    slug,
    userId,
    defaultValue,
    onChange,
    ...props}) => {

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [valid, setValid] = useState(false);
    const [verifyMode, setVerifyMode] = useState(false);
    const {showToast} = useToast();

    const changeEmail = async (e) => {
        setLoading(true);
        // get the neighboring input value
        const newEmail = e.target.parentElement.querySelector('input').value.trim();
        if(newEmail === "" || newEmail === defaultValue) {
            return; // No change
        }
        try{
            await window.Data.user.changeEmail({slug, email: newEmail});
            // Show a toast notification
            showToast("Email change initiated! Please check your email for a verification code.", { variation: "primary" });
            setVerifyMode(true);
            setValid(false);
        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }

    const verifyEmail = async (e) => {
        setLoading(true);
        try {
            let verificationCode = e.target.parentElement.querySelector('input').value.trim();
            if(!verificationCode) {
                throw new Error("Verification code is required.");
            }
            await window.Data.verify.verifyEmailVerificationCode({slug, user_id: userId, code: verificationCode});
            // Show a toast notification
            showToast("Email verified successfully!", { variation: "success" });
            onChange();
        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }


    if(!verifyMode){
        return html`
            <div class="user-change-email-container">
                <${Input}
                    type="email"
                    label="New Email:"
                    value=${defaultValue}
                    onValid=${() => setValid(true)}
                    onInvalid=${() => setValid(false)}
                    />
                <${Button} loading=${loading} disabled=${!valid} onClick=${changeEmail} variant="primary">
                    Save
                <//>
                <${Alert} type="error" message=${error} />
            </div>
        `;
    }
    else {
        return html`
            <div class="user-verify-email-container">
                <${Input}
                    type="vercode"
                    label="Email Verification Code:"
                    onValid=${() => setValid(true)}
                    onInvalid=${() => setValid(false)}
                    />
                <${Button} loading=${loading} disabled=${!valid} onClick=${verifyEmail} variant="primary">
                    Verify
                <//>
                <${Button} onClick=${() => setVerifyMode(false)}>
                    Cancel
                <//>
                <${Alert} type="error" message=${error} />
            </div>
        `;

    }
};


export default ChangeEmail;