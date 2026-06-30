import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import Input from '../../../bips/Input.js';
import Button from '../../../bips/Button.js';
import Alert from '../../../bips/Alert.js';
import { useToast } from '../../../bips/Toast/ToastContext.js';

const html = htm.bind(h);

const ChangePassword = ({
    slug,
    onChange,
    ...props}) => {

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [valid, setValid] = useState(false);
    const {showToast} = useToast();

    const changePassword = async (e) => {
        setLoading(true);
        // get the neighboring input value
        const newPassword = e.target.parentElement.querySelector('input').value.trim();
        if(newPassword === "") {
            return; // No change
        }
        try{
            await window.Data.user.changePassword({slug, password: newPassword});
            showToast("Password changed successfully!", { variation: "success" });
            onChange();
        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }

    return html`
        <div class="user-change-password-container">
            <${Input}
                type="password"
                label="New Password:"
                onValid=${() => setValid(true)}
                onInvalid=${() => setValid(false)}
                ...${props} />
            <${Button} loading=${loading} disabled=${!valid} onClick=${changePassword} variant="primary">
                Save
            <//>
            <${Alert} type="error" message=${error} />
        </div>
    `;
};

export default ChangePassword;