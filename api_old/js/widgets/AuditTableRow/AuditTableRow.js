import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import { useLocation } from 'preact-iso';
import dayjs from 'dayjs';

import htm from 'htm';
import UserSpan from '../../widgets/User/UserSpan.js';
import Gravatar from '../../bips/Gravatar.js';

const html = htm.bind(h);

const AuditTableRow = ({slug, audit, session}) => {

    if(audit.forwarded_for === "--not forwarded--"){
        audit.forwarded_for = null;
    }
    let bestIp = audit.forwarded_for || audit.ip;

    let formattedDate = dayjs(audit.created_at).format('YYYY-MM-DD HH:mm:ss');

    let isMe = session.user_id === audit.user_id;

    return html`
    <tr class="audit-table-row">
        <td class="audit-action">${audit.action}</td>
        <td class="audit-target"><${UserSpan} slug=${slug} userId=${audit.user_id} isMe=${isMe} /></td>
        <td class="audit-admin">
            ${audit.triggered_by ? html`<${UserSpan} slug=${slug} userId=${audit.triggered_by} isMe=${isMe} />` : ''}
        </td>
        <td class="audit-timestamp">${formattedDate}</td>
        <td class="audit-ip">
            <${Gravatar} hashable=${bestIp} title=${bestIp} />
        </td>
    </tr>
    `;
}

export default AuditTableRow;