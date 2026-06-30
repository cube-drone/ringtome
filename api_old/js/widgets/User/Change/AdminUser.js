import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import Button from '../../../bips/Button.js';
import Alert from '../../../bips/Alert.js';
import { useToast } from '../../../bips/Toast/ToastContext.js';

const html = htm.bind(h);

const AdminUser = ({
    slug,
    userId,
    isUserAdmin,
    onChange,
    }) => {

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const {showToast} = useToast();

    const toggleAdmin = async (e) => {
        setLoading(true);
        try {
            if(isUserAdmin) {
                // Unadmin the user
                await window.Data.user.unadminUser({slug, user_id: userId});
                // Show a toast notification
                showToast("Admin removed!", { variation: "success" });
            }
            else{
                // Admin the user
                await window.Data.user.adminUser({slug, user_id: userId});
                showToast("Admin added!", { variation: "success" });
            }
            onChange();
        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }

    let admin = "Admin";
    if(isUserAdmin) {
        admin = "Unadmin";
    }


    return html`
        <div class="user-change-lock-container">
            <p>The admin user has all of the same privileges as an owner: they can invite users,
                see all accounts, lock and delete accounts, change community settings, etc.</p>
            <${Button} loading=${loading} onClick=${toggleAdmin} variant="primary">
                ${admin} User
            <//>
            <${Alert} type="error" message=${error} />
        </div>
    `;
};


export default AdminUser;