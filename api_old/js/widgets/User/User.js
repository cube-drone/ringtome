import { h, Component, render, createRef } from 'preact';
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import PhoneNumber from '../../bips/PhoneNumber.js';
import Email from '../../bips/Email.js';
import Tag from '../../bips/Tag.js';
import Flexstack from '../../bips/Flexstack.js';
import Button from '../../bips/Button.js';
import Collapsibro from '../../bips/Collapsibro.js';
import Gravatar from '../../bips/Gravatar.js';

import ChangeName from './Change/ChangeName.js';
import ChangePassword from './Change/ChangePassword.js';
import ChangeEmail from './Change/ChangeEmail.js';
import ChangePhone from './Change/ChangePhone.js';
import LockUser from './Change/LockUser.js';
import DeleteUser from './Change/DeleteUser.js';
import AdminUser from './Change/AdminUser.js';

const User = ({user, communitySlug, slim, onUserChange, isMe=false, isAdmin=false}) => {

    let { url, path, query, route } = useLocation();

    if(onUserChange == null){
        onUserChange = () => {};
    }

    let {
        id, slug, name, email, phone_number, tags, created_at, updated_at
    } = user;

    let filteredTags = tags || [];
    let emailVerified = filteredTags.includes('email_verified');
    let phoneVerified = filteredTags.includes('phone_verified');

    let locked = filteredTags.includes('locked');
    let lockText = locked ? 'Unlock User' : 'Lock User';

    let isUserAdmin = filteredTags.includes('admin') || filteredTags.includes('super_admin') || filteredTags.includes('owner');
    let adminText = isUserAdmin ? 'Remove User Admin' : 'Make User Admin';

    let canRemoveAdmin = !filteredTags.includes('owner') && !filteredTags.includes('super_admin');
    let canDeleteUser = !filteredTags.includes('owner') && !filteredTags.includes('super_admin');

    let userLink = `/community/${communitySlug}/users/${slug}`;
    if(isMe){
        userLink = `/community/${communitySlug}/profile`;
    }

    if(slim){
        return html`
        <div class="user-card ${isMe ? 'user-card-me' : ''} user-card-slim slim">
            <${Flexstack}>
                <span class="user-gravatar">
                    <a href=${userLink}>
                        <!-- because we only have a "real" email for the user if they're... us, the Gravatar instructions are different -->
                        ${isMe ?
                            html`<${Gravatar} hashable=${user.email} defaultType="wavatar" title=${name} />` :
                            html`<${Gravatar} hashable=${user.id} overrideSha=${user.email} defaultType="wavatar" title=${name} />`}
                    </a>
                </span>
                <span class="user-tags">
                    ${filteredTags.map(tag => html`<${Tag} tag=${tag} slim=${true} />`)}
                </span>
                <span class="user-name">
                    <a href="${userLink}">${name}</a>
                </span>
            <//>
        </div>
        `;
    }

    return html`
    <div class="user-card ${isMe ? 'user-card-me' : ''}">
        <h3><a href="${userLink}">${name}</a></h3>
        <p class="user-card-id"><small>${slug} (${id})</small></p>
        <!-- Only admins can see the full user card -->
        ${isAdmin ? html`
            <${Flexstack}>
                <div class="user-card-info">
                    <h4>User Info</h4>
                    <table class="user-card-table">
                        <tbody>
                            ${isMe && html`
                                <tr>
                                    <th>Email:</th>
                                    <td>${email ? html`<${Email} email=${email} verified=${emailVerified} />` : 'N/A'}</td>
                                </tr>
                                <tr>
                                    <th>Phone:</th>
                                    <td>${phone_number ? html`<${PhoneNumber} phoneNumber=${phone_number} verified="${phoneVerified}" />` : 'N/A'}</td>
                                </tr>
                            `}
                            <tr>
                                <th>Created:</th>
                                <td>${new Date(created_at).toLocaleDateString()}</td>
                            </tr>
                            <tr>
                                <th>Updated:</th>
                                <td>${new Date(updated_at).toLocaleDateString()}</td>
                            </tr>
                            <tr>
                                <th>Last Login:</th>
                                <td>${user.last_login ? new Date(user.last_login).toLocaleDateString() : 'N/A'}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div>
                    <h4>User Tags</h4>
                    <p><ul class="user-tags">${filteredTags.map(tag => html`<li><${Tag} tag=${tag} /></li>`)}</ul></p>
                </div>
            <//>` : ''}
        <!-- Only admins can see admin actions -->
        ${isAdmin ? html`
            <h4>Admin Actions</h4>

            <${Collapsibro} variant="default" title="User Logs">
                <div>
                    <${Button} onClick=${() => route(`/community/${communitySlug}/audit?user_id=${id}`)}>User Logs<//>
                    <${Button} onClick=${() => route(`/community/${communitySlug}/audit?triggered_by=${id}`)}>User Admin Actions<//>
                </div>
            <//>
        ` : ''}
        ${isAdmin && !isMe ? html `
            <${Collapsibro} variant="default" title="${adminText}" visible=${canRemoveAdmin}>
                <div>
                    <${AdminUser} slug=${communitySlug} userId=${id} isUserAdmin=${isUserAdmin} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro} variant="warning" title="${lockText}" visible=${canDeleteUser}>
                <div>
                    <${LockUser} slug=${communitySlug} userId=${id} locked=${locked} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro} variant="warning" title="Delete User" visible=${canDeleteUser}>
                <div>
                    <${DeleteUser} slug=${communitySlug} userId=${id} onChange=${onUserChange} />
                </div>
            <//>
        ` : ''}
        <!-- The things I can do to myself -->
        ${isMe ? html`
            <h4>Account Settings</h4>
            <${Collapsibro} title="Logout">
                <div>
                    <${Button} onClick=${() => route(`/community/${communitySlug}/logout`)}>Logout<//>
                </div>
            <//>
            <${Collapsibro} title="Change Name">
                <div>
                    <${ChangeName} slug=${communitySlug} defaultValue=${name} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro} title="Change Password">
                <div>
                    <${ChangePassword} slug=${communitySlug} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro} title="Change Email">
                <div>
                    <${ChangeEmail} slug=${communitySlug} userId=${id} defaultValue=${email} onChange=${onUserChange} />
                </div>
            <//>
            <${Collapsibro} title="Change Phone Number">
                <div>
                    <${ChangePhone} slug=${communitySlug} userId=${id} defaultValue=${phone_number} onChange=${onUserChange} />
                </div>
            <//>
        ` : ''}

    </div>
    `;
}

export default User;