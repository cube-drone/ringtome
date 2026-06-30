import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import Input from '../../../bips/Input.js';
import Button from '../../../bips/Button.js';
import Alert from '../../../bips/Alert.js';
import { useToast } from '../../../bips/Toast/ToastContext.js';

const html = htm.bind(h);

const ChangePhone = ({
    slug,
    userId,
    defaultValue,
    onChange,
    }) => {

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [valid, setValid] = useState(false);
    const [verifyMode, setVerifyMode] = useState(false);
    const { showToast } = useToast();

    const changePhone = async (e) => {
        setLoading(true);
        // get the neighboring input value
        const newPhone = e.target.parentElement.querySelector('input').value.trim();
        if(newPhone === "" || newPhone === defaultValue) {
            return; // No change
        }
        try{
            await window.Data.user.changePhone({slug, phone_number: newPhone});
            setVerifyMode(true);
            setValid(false);
            e.target.parentElement.querySelector('input').value = ''; // Clear input
            showToast("Phone change initiated! Please check your phone for a verification code.", { variation: "primary" });
        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }

    const verifyPhone = async (e) => {
        setLoading(true);
        try {
            let verificationCode = e.target.parentElement.querySelector('input').value.trim();
            if(!verificationCode) {
                throw new Error("Verification code is required.");
            }
            await window.Data.verify.verifySmsVerificationCode({slug, user_id: userId, code: verificationCode});
            showToast("Phone verified successfully!", { variation: "success" });
            onChange();
        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }


    if(!verifyMode){
        return html`
            <div class="user-change-phone-container">
                <${Input}
                    type="tel"
                    label="New Phone:"
                    value=${defaultValue}
                    onValid=${() => setValid(true)}
                    onInvalid=${() => setValid(false)}
                    />
                <${Button} loading=${loading} disabled=${!valid} onClick=${changePhone} variant="primary">
                    Save
                <//>
                <${Alert} type="error" message=${error} />
            </div>
        `;
    }
    else {
        return html`
            <div class="user-verify-phone-container">
                <${Input}
                    type="vercode"
                    label="Phone Verification Code:"
                    value=""
                    onValid=${() => setValid(true)}
                    onInvalid=${() => setValid(false)}
                    />
                <${Button} loading=${loading} disabled=${!valid} onClick=${verifyPhone} variant="primary">
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


export default ChangePhone;