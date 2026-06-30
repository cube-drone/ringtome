import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import Alert from '../../bips/Alert.js';
import Checkbox from '../../bips/Checkbox.js';

const CommunitySettings = ({slug, session}) => {

    let [error, setError] = useState(null);
    let [settings, setSettings] = useState({});
    let [loading, setLoading] = useState(true);
    let { url, path, query, route } = useLocation();

    useEffect(() => {
        // Fetch users from the API
        const fetchCommunitySettings = async () => {
            try {
                let settings = await window.Data.community.getCommunitySettings({slug});
                setSettings(settings);
            } catch (e) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        };
        fetchCommunitySettings();
    }, []);

    const toggleSetting = async (settingKey, value) => {
        try {
            let newSettings = {...settings, [settingKey]: value};
            let updatedSettings = await window.Data.community.setCommunitySettings({slug, settings: newSettings});
            setSettings(updatedSettings);
        } catch (e) {
            setError(e.message);
        }
    };

    // we COULD do something ridiculous like guess at the settings schema by looking at the values
    // if it's "glerg" it's a text form, if it's "false" use a checkbox, that kind of thing -
    // but, uh, why? We should always know all of the settings ahead of time, so that kind of
    // complex guesswork doesn't seem necessary.

    return html`
    <div class="community-settings">

        <h3>Settings</h3>

        <${Checkbox}
            label="Enable Viral Invitations"
            description="When this is enabled, non-admin users can generate single-use invitation codes."
            id="viral_growth_enabled"
            onChange=${(e) => {
                toggleSetting('viral_growth_enabled', e.target.checked);
            }}
            checked=${settings?.viral_growth_enabled || false}/>
        <br/>
        <${Checkbox}
            label="Lock Community"
            description="When this is enabled, new users cannot join the community at all, even if they have invitation codes."
            id="lock_community"
            onChange=${(e) => {
                toggleSetting('lock_community', e.target.checked);
            }}
            checked=${settings?.lock_community || false}
        />
        <br/>

        <${Alert} type="error" message=${error} />

    </div>

    `;
}

export default CommunitySettings;