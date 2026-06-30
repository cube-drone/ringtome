import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { lazy, LocationProvider, ErrorBoundary, Router, Route } from 'preact-iso';

import Home from './pages/Home.js';
import LoadingPage from './pages/LoadingPage.js';
import Data from './Data.js';
import ToastProvider from './bips/Toast/ToastProvider.js';

const html = htm.bind(h);

const App = () => html`
  <${LocationProvider}>
    <${ErrorBoundary} onError=${error => console.error(error)}>
      <${ToastProvider}>
        <div class="app-main">
            <${Router}>
                <${Route} path="/" component=${Home} />
                <${Route} path="/home" component=${Home} />
                <${Route} path="/home/loading" component=${LoadingPage} />
                <${Route} path="/home/about" component=${lazy(() => import('./pages/AboutPage.js'))} />
                <${Route} path="/home/bip" component=${lazy(() => import('./bips/BipSamplePage.js'))} />
                <${Route} path="/home/create" component=${lazy(() => import('./pages/CommunityCreatePage.js'))} />
                <${Route} path="/home/terms" component=${lazy(() => import('./pages/TermsAndConditions.js'))} />
                <${Route} path="/home/find" component=${lazy(() => import('./pages/CommunityFindPage.js'))} />
                <${Route} path="/community/:slug" component=${lazy(() => import('./pages/CommunityPage.js'))} />
                <${Route} path="/community/:slug/verify" component=${lazy(() => import('./pages/CommunityVerifyPage.js'))} />
                <${Route} path="/community/:slug/verify/link" component=${lazy(() => import('./pages/CommunityVerify/CommunityVerifyLinkPage.js'))} />
                <${Route} path="/community/:slug/login" component=${lazy(() => import('./pages/LoginPage.js'))} />
                <${Route} path="/community/:slug/logout" component=${lazy(() => import('./pages/LogoutPage.js'))} />
                <${Route} path="/community/:slug/invite" component=${lazy(() => import('./pages/Community/InviteCodePage.js'))} />
                <${Route} path="/community/:slug/invite/:id" component=${lazy(() => import('./pages/UserRegistrationPage.js'))} />
                <${Route} path="/community/:slug/users" component=${lazy(() => import('./pages/Community/CommunityUsersPage.js'))} />
                <${Route} path="/community/:slug/users/:userSlug" component=${lazy(() => import('./pages/Community/UserPage.js'))} />
                <${Route} path="/community/:slug/profile" component=${lazy(() => import('./pages/Community/ProfilePage.js'))} />
                <${Route} path="/community/:slug/audit" component=${lazy(() => import('./pages/Community/CommunityAuditPage.js'))} />
                <${Route} path="/community/:slug/messages" component=${lazy(() => import('./pages/Community/CommunityMessagesPage.js'))} />
                <${Route} path="/community/:slug/admin" component=${lazy(() => import('./pages/Community/CommunityAdminPage.js'))} />
            <//>
        </div>
      <//>
    <//>
  <//>
  `

async function main(){
    let app = document.getElementById('app');

    let endpoint = window.location.origin;
    let data = new Data({endpoint, options: {network_simulation: true}});
    // here's a bunch of stuff we need to do before we can render the app
    await data.boot();
    window.Data = data;
    console.log("Application booted successfully!");

    render(html`<${App} />`, app);
}

console.log("JS loaded!");
main();