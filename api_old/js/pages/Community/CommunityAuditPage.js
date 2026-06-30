import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

import AuditTableRow from '../../widgets/AuditTableRow/AuditTableRow.js';

const html = htm.bind(h);

import CommunityHomePageLayout from './CommunityHomePageLayout.js';
import Alert from '../../bips/Alert.js';
import Button from '../../bips/Button.js';

const CommunityAuditPage = ({slug}) => {

    let [error, setError] = useState(null);
    let [session, setSession] = useState(null);
    let [audits, setAudits] = useState([]);
    let [loading, setLoading] = useState(true);
    let [n, setN] = useState(100);
    let [moreResults, setMoreResults] = useState(true);
    let [offset, setOffset] = useState(0);
    let { url, path, query, route } = useLocation();


    useEffect(() => {
        // Fetch users from the API
        const fetchAudits = async () => {
            try {
                console.dir(query);

                let session = await window.Data.session.getSession({slug});
                setSession(session);
                let resp = await window.Data.audit.getAudits({slug, ...query, n, offset});
                if( resp.length < n) {
                    setMoreResults(false);
                }
                setAudits(resp);
            } catch (e) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        };
        fetchAudits();
    }, []);

    let more = async () => {
        setLoading(true);
        try {
            let newOffset = offset + n;
            let resp = await window.Data.audit.getAudits({slug, ...query, n, offset: newOffset});
            setOffset(newOffset);
            if (resp.length < n) {
                setMoreResults(false);
            }
            setAudits([...audits, ...resp]);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }

    return html`
    <${CommunityHomePageLayout} loading=${loading} slug=${slug} pageName="Users">
        <h2>Logs</h2>

        <${Alert} type="error" message=${error} />

        <table class="audit-table">
            <tr>
                <th>Type</th>
                <th>User</th>
                <th>Admin</th>
                <th>Time</th>
                <th class="audit-ip">IP</th>
            </tr>

            ${audits?.map(audit => html`
                <${AuditTableRow} slug=${slug} audit=${audit} key=${audit.id} session=${session} />
            `)}
        </table>

        ${moreResults && html`<${Button} loading=${loading} onClick=${more}>Load More...<//>`}

    <//>
    `;
}

export default CommunityAuditPage;