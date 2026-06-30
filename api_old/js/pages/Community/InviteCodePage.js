import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';
import { Box, Boxes } from 'lucide-preact';

const html = htm.bind(h);

import Button from '../../bips/Button.js';

import CommunityHomePageLayout from './CommunityHomePageLayout.js';
import Alert from '../../bips/Alert.js';
import ButtonFrame from '../../bips/ButtonFrame.js';
import Flexstack from '../../bips/Flexstack.js';
import UserSpan from '../../widgets/User/UserSpan.js';
import { useToast } from '../../bips/Toast/ToastContext.js';

let useTypeToLabel = {
    once: 'Single Use',
    Once: 'Single Use',
    unlimited: 'Unlimited',
    Unlimited: 'Unlimited'
};

let useTypeToIcon = {
    once: Box,
    Once: Box,
    unlimited: Boxes,
    Unlimited: Boxes
};

const InviteCode = ({slug, code, session, onDelete}) => {

    const [ loading, setLoading ] = useState(false);

    let linkTarget = `/community/${slug}/invite/${code.invite_code}`;
    let fullLinkTarget = `${window.location.origin}${linkTarget}`;
    let label = useTypeToLabel[code.use_type] || `${code.use_type}?`;
    let UseTypeIcon = useTypeToIcon[code.use_type] || Box;
    let createdBy = code.created_by;
    let createdByMe = (session?.user_id === createdBy);

    const deleteInviteCode = async (code) => {
        setLoading(true);
        await onDelete(code);
        setLoading(false);
    }

    return html`
        <div class="invite-code invite-${code.use_type.toLowerCase()}">
            <h3> <${UseTypeIcon} /> ${label} </h3>
            <p class="invite-code-date date"> ${new Date(code.created_at).toLocaleString()} </p>
            ${createdByMe ? null : html`
            <p class="invite-code-created-by">
                <${UserSpan} slug=${slug} userId=${createdBy} isMe=${createdByMe} />
            </p>
            `}
            <p class="invite-code-body">
                <a href="${linkTarget}" target="_blank">
                    ${fullLinkTarget}
                </a>
            </p>
            <${Button} onClick=${() => { navigator.clipboard.writeText(fullLinkTarget); } }> Copy Link to Clipboard </${Button}>
            <${Button} loading=${loading} onClick=${() => { deleteInviteCode(code.invite_code) }}> Delete </${Button}>
        </div>
    `;

}


const InviteCodeSection = ({slug}) => {

    let [error, setError] = useState(null);
    let [session, setSession] = useState(null);
    let [inviteCodes, setInviteCodes] = useState(null);
    let { url, path, query, route } = useLocation();
    const {showToast} = useToast();

    let [ singleUseLoading, setSingleUseLoading ] = useState(false);
    let [ unlimitedLoading, setUnlimitedLoading ] = useState(false);

    useEffect(() => {
        if(error){
            console.error(error);
        }
    }, [error]);

    useEffect(async () => {
        try{
            // check if logged in
            let session = await window.Data.session.getSession({slug});
            setSession(session);

            let inviteCodes = await window.Data.invitecode.getInviteCodes({slug});
            setInviteCodes(inviteCodes);

        }
        catch(e){
            setError(e.message);
        }
    }, []);

    const createOnceInviteCode = async () => {
        setSingleUseLoading(true);
        try{
            let code = await window.Data.invitecode.createInviteCode({slug, use_type: "once"});
            showToast("Invite code created!", { variation: "success" });
            setInviteCodes([code, ...inviteCodes]);
        }
        catch(e){
            setError(e.message);
        }
        setSingleUseLoading(false);
    };

    const createUnlimitedInviteCode = async () => {
        setUnlimitedLoading(true);
        try{
            let code = await window.Data.invitecode.createInviteCode({slug, use_type: "unlimited"});
            showToast("Invite code created!", { variation: "success" });
            console.dir(code);
            setInviteCodes([code, ...inviteCodes]);
        }
        catch(e){
            setError(e.message);
        }
        setUnlimitedLoading(false);
    };

    const deleteInviteCode = async (code) => {
        try{
            await window.Data.invitecode.deleteInviteCode({slug, code});
            showToast("Invite code deleted!", { variation: "success" });
            setInviteCodes(inviteCodes.filter((c) => c.invite_code !== code));
        }
        catch(e){
            setError(e.message);
        }
    }

    let inviteCodeList = null;
    if(inviteCodes){
        inviteCodeList = inviteCodes.map((code) => {
            return html`
                <${InviteCode} slug=${slug} session=${session} code=${code} onDelete=${async () => deleteInviteCode(code.invite_code)} />
            `;
        });
    }
    if(!inviteCodes || inviteCodeList.length == 0){
        inviteCodeList = html`
            <${Alert} title="No Invite Codes" message="You have not created any invite codes yet."
                variant="null"/>
        `;
    }

    return html`
        <h2> <small><a href=${`/community/${slug}/users`}>Users /</a></small>  Invite </h2>
        <hr/>
        <${Flexstack}>
            <${ButtonFrame} loading=${singleUseLoading} title="Create Single Use Invite Code" label="Create" onClick=${createOnceInviteCode}>
                <div>
                    <${Box} />
                </div>
                A Single-Use Invite Code will disappear after a single user uses it to create an account!
                ${session?.is_admin ? html`Use it to tightly control access to your community!` : ''}
            <//>
            ${session?.is_admin ? html`
            <${ButtonFrame} loading=${unlimitedLoading} title="Create Unlimited Invite Code" label="Create" onClick=${createUnlimitedInviteCode}>
                <div>
                    <${Boxes} />
                </div>
                An Unlimited Invite Code will never disappear! Use it to allow anyone to join your community!
            <//>
            ` : ''}
        <//>
        <${Alert} message=${error} />
        <hr/>
        ${inviteCodeList}
    `;
}

const InviteCodePage = ({slug}) => {
    return html`
        <${CommunityHomePageLayout} slug=${slug} pageName="Invite Codes">
            <${InviteCodeSection} slug=${slug} />
        <//>
    `;
}

export default InviteCodePage;