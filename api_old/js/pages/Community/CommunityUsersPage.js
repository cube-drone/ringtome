import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { UserRoundPlus } from 'lucide-preact';

const html = htm.bind(h);

import CommunityHomePageLayout from './CommunityHomePageLayout.js';
import Alert from '../../bips/Alert.js';
import Button from '../../bips/Button.js';
import Searchbar from '../../bips/Searchbar.js';
import User from '../../widgets/User/User.js';

const CommunityUsersPage = ({slug}) => {

    let [error, setError] = useState(null);
    let [session, setSession] = useState(null);
    let [users, setUsers] = useState([]);
    let [communitySettings, setCommunitySettings] = useState({});
    let [currentUserId, setCurrentUserId] = useState(null);
    let [visibleUsers, setVisibleUsers] = useState([]);
    let [loading, setLoading] = useState(true);
    let { url, path, query, route } = useLocation();

    useEffect(() => {
        // Fetch users from the API
        const fetchUsers = async () => {
            try {
                let session = await window.Data.session.getSession({slug});
                setSession(session);
                setCurrentUserId(session.user_id);
                let resp = await window.Data.user.listUsers({slug});
                setUsers(resp);
                setVisibleUsers(resp);
                let settings = await window.Data.community.getCommunitySettings({slug});
                setCommunitySettings(settings);
            } catch (e) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        };
        fetchUsers();
    }, []);

    updateSearch = (evt) => {
        console.log('Search term:', evt.target.value);
        let searchTerm = evt.target.value.toLowerCase();
        if (searchTerm) {
            let filteredUsers = users.filter(user => {
                if(!user) return false;
                if(user.name && user.name.toLowerCase().includes(searchTerm)) return true;
                if(user.email && user.email.toLowerCase().includes(searchTerm)) return true;
                if(user.phone_number && user.phone_number.toLowerCase().includes(searchTerm)) return true;
                if(user.tags && user.tags.some(tag => tag.toLowerCase().includes(searchTerm))) return true;
                return false;
            });
            setVisibleUsers(filteredUsers);
        } else {
            setVisibleUsers(users);
        }
    }

    sortUsersWithOrder = (sortOrder) => {
        let sortedUsers = [...visibleUsers].sort((a, b) => {
            if (sortOrder === 'name a-z') {
                if(a.name && !b.name) return -1;
                if(!a.name && b.name) return 1;
                if(!a.name && !b.name) return 0;
                return a?.name.localeCompare(b.name || '');
            }
            else if (sortOrder === 'name z-a') {
                if(a.name && !b.name) return 1;
                if(!a.name && b.name) return -1;
                if(!a.name && !b.name) return 0;
                return b?.name.localeCompare(a.name || '');
            }
            else if (sortOrder === 'email a-z') {
                if(a.email && !b.email) return -1;
                if(!a.email && b.email) return 1;
                if(!a.email && !b.email) return 0;
                return a?.email.localeCompare(b.email || '');
            }
            else if (sortOrder === 'email z-a') {
                if(a.email && !b.email) return 1;
                if(!a.email && b.email) return -1;
                if(!a.email && !b.email) return 0;
                return b?.email.localeCompare(a.email || '');
            }
            else if (sortOrder === 'created_at newest first') {
                return new Date(b.created_at) - new Date(a.created_at);
            }
            else if (sortOrder === 'created_at oldest first') {
                return new Date(a.created_at) - new Date(b.created_at);
            }
            else if (sortOrder === 'updated_at newest first') {
                return new Date(b.updated_at) - new Date(a.updated_at);
            }
            else if (sortOrder === 'updated_at oldest first') {
                return new Date(a.updated_at) - new Date(b.updated_at);
            }
            else if (sortOrder === 'last_login newest first') {
                return new Date(b.last_login) - new Date(a.last_login);
            }
            else if (sortOrder === 'last_login oldest first') {
                return new Date(a.last_login) - new Date(b.last_login);
            }
            return 0;
        });
        setVisibleUsers(sortedUsers);
    }


    sortUsers = (evt) => {
        let sortOrder = evt.target.value;
        console.log('Sort order:', sortOrder);
        sortUsersWithOrder(sortOrder);
    }

    return html`
    <${CommunityHomePageLayout} loading=${loading} slug=${slug} pageName="Users">
        <h2>Users</h2>

        <${Searchbar} onChange=${updateSearch} />

        <!-- select a sort order from a dropdown -->
        <div class="users-options">
            <div class="bip-sort-order">
                <label for="sort-order">Sort by:</label>
                <select id="sort-order" onChange=${sortUsers}>
                    <option value="name a-z">Name A-Z</option>
                    <option value="name z-a">Name Z-A</option>
                    <option value="email a-z">Email A-Z</option>
                    <option value="email z-a">Email Z-A</option>
                    <option value="created_at newest first">Created At (Newest First)</option>
                    <option value="created_at oldest first">Created At (Oldest First)</option>
                    <option value="updated_at newest first">Last Update (Most Recent First)</option>
                    <option value="updated_at oldest first">Last Update (Least Recent First)</option>
                    <option value="last_login newest first">Last Login (Most Recent First)</option>
                    <option value="last_login oldest first">Last Login (Least Recent First)</option>
                </select>
            </div>

            ${session?.is_admin || communitySettings?.viral_growth_enabled ? html`
                <div class="invite-button">
                    <${Button} variant="primary" onClick=${() => route(`/community/${slug}/invite`)}><${UserRoundPlus} //> Invite People to Community<//>
                </div>
            ` : ''}
        </div>

        <${Alert} type="error" message=${error} />

        ${visibleUsers?.map(user => html`
            <${User} user=${user} communitySlug=${slug} isMe=${currentUserId === user.id} slim=${true} isAdmin=${session.is_admin} />
        `)}

    <//>
    `;
}

export default CommunityUsersPage;