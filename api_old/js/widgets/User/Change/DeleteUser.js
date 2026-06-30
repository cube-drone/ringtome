import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import { useLocation } from 'preact-iso';
import htm from 'htm';

import Input from '../../../bips/Input.js';
import Button from '../../../bips/Button.js';
import Alert from '../../../bips/Alert.js';
import { useToast } from '../../../bips/Toast/ToastContext.js';

const html = htm.bind(h);

const DeleteUser = ({
    slug,
    userId,
    defaultValue=''}) => {

    const [loading, setLoading] = useState(false);
    const [valid, setValid] = useState(false);
    const [error, setError] = useState(null);
    const {showToast} = useToast();
    let { url, path, query, route } = useLocation();

    const deleteUser = async (e) => {
        setLoading(true);
        // get the neighboring input value
        const confirmText = e.target.parentElement.querySelector('input').value.trim().toLowerCase();
        if(confirmText !== "i understand") {
            setValid(false);
            return; // Invalid confirmation text
        }
        try{
            showToast("User deleted successfully!", { variation: "warning" });
            await window.Data.user.deleteUser({slug, user_id: userId});

            // instead of onChange, we need to leave this page entirely (they died)
            route(`/community/${slug}/users/`);

        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }

    return html`
        <div class="user-change-name-container">
            <p>Are you sure you want to delete this user? This action cannot be undone.</p>
            <${Input}
                type="text"
                regex="^i understand$"
                label="Please type 'i understand' to confirm:"
                onValid=${() => setValid(true)}
                onInvalid=${() => setValid(false)}
                />
            <${Button} loading=${loading} disabled=${!valid} onClick=${deleteUser} variant="warning">
                Delete
            <//>
            <${Alert} type="error" message=${error} />
        </div>
    `;
};

export default DeleteUser;