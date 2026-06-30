import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import { useLocation } from 'preact-iso';
import htm from 'htm';

import Loading from '../bips/Loading';

const html = htm.bind(h);

const BasicPageLayout = ({title, loading, children, fullyTransparent=false, ...props}) => {

    // we want to provide a "< back" button, but only if we're not currently on the home page

    let [version, setVersion] = useState(null);
    let [environment, setEnvironment] = useState(null);

    useEffect(async () => {
        let config = await window.Data.config();
        setVersion(config.app_version);
        setEnvironment(config.environment);
    }, []);

    let { url, path, query, route } = useLocation();
    const isHomePage = url === '/';

    const loadingOrChildren = loading ? html`<${Loading} center margin />` : children;

    let extraClass = fullyTransparent ? "" : " basic-glossy-panel";

    return html`
    <div class="basic-page-layout" ...${props}>
        ${!isHomePage && html`
            <nav class="top-nav">
                <h1> ${!isHomePage ? html`<a class="home-link" href="/" title="Home">home / </a> ` : ''}${title} </h1>
            </nav>
        `}
        <div class="content ${extraClass}">
            <div class="content-inner">
                ${loadingOrChildren}
            </div>
        </div>
        <div class="footer">
            <span class="version-env">
                <a target="_blank" href="/public/${version}/git-log.txt">
                    v.${version ? version : '...'}${environment && environment !== 'production' ? ` (${environment})` : ''}
                </a>
            </span>
            <span class="tos">
                <a href="/home/terms" target="_blank">Legal</a>
            </span>
        </div>
    </div>
    `;
}

export default BasicPageLayout;