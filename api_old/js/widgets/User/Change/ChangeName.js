import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';

import Input from '../../../bips/Input.js';
import Button from '../../../bips/Button.js';
import Alert from '../../../bips/Alert.js';
import { useToast } from '../../../bips/Toast/ToastContext.js';

const html = htm.bind(h);

const ChangeName = ({
    slug,
    onChange,
    defaultValue='',
    ...props}) => {

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const {showToast} = useToast();

    const changeName = async (e) => {
        setLoading(true);
        // get the neighboring input value
        const newName = e.target.parentElement.querySelector('input').value.trim();
        if(newName === defaultValue) {
            return; // No change
        }
        try{
            await window.Data.user.changeName({slug, name: newName});
            showToast(`Okay ${newName}, your name is ${newName} now.`, { variation: "success" });
            onChange(newName);
        } catch (e) {
            console.error(e);
            setError(e.message);
        }
        setLoading(false);
    }

    return html`
        <div class="user-change-name-container">
            <${Input}
                type="text"
                label="New Name:"
                value=${defaultValue}
                ...${props} />
            <${Button} loading=${loading} onClick=${changeName} variant="primary">
                Save
            <//>
            <${Alert} type="error" message=${error} />
        </div>
    `;
};

export default ChangeName;