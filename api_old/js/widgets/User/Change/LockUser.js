import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import Button from '../../../bips/Button.js';
import Alert from '../../../bips/Alert.js';
import { useToast } from '../../../bips/Toast/ToastContext.js';

const html = htm.bind(h);

const LockUser = ({
    slug,
    userId,
    locked,
    onChange,
    }) => {

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const {showToast} = useToast();

    const toggleLock = async (e) => {
        setLoading(true);
        try {
            if(locked) {
                // Unlock the user
                await window.Data.user.unlockUser({slug, user_id: userId});
                // Show a toast notification
                showToast("User unlocked!", { variation: "success" });
            }
            else{
                // Lock the user
                await window.Data.user.lockUser({slug, user_id: userId});
                showToast("User locked!", { variation: "success" });
            }
            onChange();
        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }

    let lock = "Lock";
    if(locked) {
        lock = "Unlock";
    }


    return html`
        <div class="user-change-lock-container">
            <p>If a user is locked, they will not be able to log in or access their account.</p>
            <${Button} loading=${loading} onClick=${toggleLock} variant="primary">
                ${lock} User
            <//>
            <${Alert} type="error" message=${error} />
        </div>
    `;
};


export default LockUser;