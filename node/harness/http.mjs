// The harness's HTTP half: a cookie-jar session per node, and nothing else.
//
// Split out of boot.mjs (2026-08-05) when the test-data generator crashed on an old Node -
// not on its own code, but on jsdom's, which boot.mjs imports and which a script that never
// opens a page has no business loading. boot.mjs layers the browser (jsdom + WebSocket +
// mirror bridge) on top of this; anything that only talks to the API imports from here and
// starts in milliseconds instead of loading a fake browser.
//
// Needs Node 18+ (global fetch). The just recipes that run these scripts check first.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// One node's cookie-carrying fetch. `cookieHeader()` exposes the jar for anything that must
/// smuggle the session into a non-fetch transport (boot.mjs's WebSocket bridge).
export function httpSession(base) {
    let cookies = '';
    const bridgedFetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, base).href;
        const headers = new Headers(init.headers || {});
        if (cookies) headers.set('cookie', cookies);
        const resp = await fetch(url, { ...init, headers, redirect: 'manual' });
        // getSetCookie is Node 18.14+; the fallback reads the single session cookie this
        // server actually sets (a joined multi-cookie header would mangle - we set one).
        const setc = resp.headers.getSetCookie
            ? resp.headers.getSetCookie()
            : [resp.headers.get('set-cookie')].filter(Boolean);
        for (const c of setc) {
            const pair = c.split(';')[0];
            const name = pair.split('=')[0];
            cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(name + '=')), pair].join('; ');
        }
        return resp;
    };
    return { fetch: bridgedFetch, cookieHeader: () => cookies };
}
