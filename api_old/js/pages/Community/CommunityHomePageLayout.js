import { h, Component, render, createRef } from 'preact';
import { useState, useEffect, useContext } from 'preact/hooks'
import { useLocation } from 'preact-iso';
import htm from 'htm';

import { House, Mails, CircleUser, UserSearch, ServerCog } from 'lucide-preact';
import Loading from '../../bips/Loading';
import { useToast } from '../../bips/Toast/ToastContext.js';
import Toast from '../../bips/Toast/Toast.js';

const html = htm.bind(h);

const CommunityHomePageLayout = ({slug, loading, pageName, fullyTransparent=false, children}) => {

    let { url, path, query, route } = useLocation();
    let [loggedIn, setLoggedIn] = useState(false);
    let [session, setSession] = useState(null);
    let [admin, setAdmin] = useState(false);
    let [unseenMessageCount, setMessageCount] = useState(0);
    let { getToasts, dismissToast } = useToast();
    let toasts = getToasts();

    let extraClass = fullyTransparent ? "" : " basic-glossy-panel";

    useEffect(async () => {
        // if we don't have a session, redirect to the community page for this slug
        try{
            let session = await window.Data.session.getSession({slug});

            if(!session){
                // if we're already on the community page, don't redirect
                if(url.includes(`/community/${slug}`)){
                    setLoggedIn(false);
                    return;
                }
                else{
                    route(`/community/${slug}`);
                }
            }
            else{
                console.dir(session);
                document.title = `${session.community_name} ${pageName ? `| ${pageName}` : ''}`;

                setSession(session);
                setLoggedIn(true);
                if(session.is_admin){
                    setAdmin(true);
                }
            }

            // how many unseen messages do we have?
            let count = await window.Data.message.getUnseenMessageCount({slug});
            setMessageCount(count);

            // boot up the "live" system
            await window.Data.live.createConnection({slug});
            window.Data.live.on("MessagesChanged", async () => {
                let count = await window.Data.message.getUnseenMessageCount({slug});
                setMessageCount(count);
            });
        }
        catch(e){
            // if we're logged in but not verified, send to verify page, it will figure things out from there
            if(e?.message.includes("not verified")){
                route(`/community/${slug}/verify`);
                return;
            }
            console.error("Error fetching sossion:", e);
            // if we can't get the session, redirect to the community page
            if(url !== `/community/${slug}`){
                console.warn("routing to community page due to session error");
                route(`/community/${slug}`);
            }
        }

        // TODO: set up messages & profile?

    }, [pageName]);

    let communityName = session?.community_name || "loading...";
    let userName = session?.user_name || "loading...";
    let loadingOrChildren = loading ? html`<${Loading} center margin />` : children;

    return html`
    <div class="basic-page-layout">
            <nav class="top-nav no-print">
                <a href="/community/${slug}" title=${communityName}>
                    <${House} />
                </a>
                <a href="/community/${slug}/messages">
                    <${Mails} />
                    ${unseenMessageCount > 0 ? html`<span class="message-count-badge">${unseenMessageCount}</span>` : null}
                </a>
                <a href="/community/${slug}/users" title="Users">
                    <${UserSearch} />
                </a>
                <a href="/community/${slug}/profile" title=${userName}>
                    <${CircleUser} />
                </a>
                ${admin ? html`
                <a href="/community/${slug}/admin" title="Admin" style=${admin ? "" : "display: none;"}>
                    <${ServerCog} />
                </a>
                ` : null}
            </nav>

            <div>
                <div class="content ${extraClass}">
                    <div class="content-inner">
                        ${loadingOrChildren}
                    </div>
                </div>
                <div class="bip-toast-container">
                    ${toasts.map(toast => (
                    html`<${Toast} key=${toast.id} message=${toast.message} options=${toast.options} onDismiss=${() => dismissToast(toast.id)} />`
                    ))}
                </div>
            </div>
    </div>
    `;
}

export default CommunityHomePageLayout;