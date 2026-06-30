import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { marked } from 'marked';

const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';

const aboutMarkdown = `

# What is groovelet.com?

Hi, I'm [Curtis](https://cube-drone.com)!

(now describe what groovelet.com is: a web game, go into more detail about this)

If you want to reach me, I'm always available at [groovelet@gooble.email](mailto:groovelet@gooble.email).

`;

const AboutPage = () => {

    let parsed = marked(aboutMarkdown);

    useEffect(() => {
        document.title = "About";
    }, []);

    return html`
    <${BasicPageLayout} title="About">
        <div dangerouslySetInnerHTML=${{__html: parsed}}></div>
    </div>
    `;
}

export default AboutPage;