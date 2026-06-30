const tty = require('testytesterson');
const makeFetchHappen = require('./fetch.cjs');
const assert = require('assert');
const crypto = require('node:crypto');
const { host } = require('./localhost.cjs');
const WebSocket = require('ws');

let gen_number = () => {
    let number = `1` + `${Math.floor(Math.random() * 10000000000)}`.padStart(10, '0');
    return number;
};

let gen_uuid = () => {
    return crypto.randomUUID();
};

let uuid = () => {
    return crypto.randomUUID();
};

let gen_community = () => {
    let community_name = tty.groupName();
    let name = tty.name();
    let email = tty.email();
    let phone_number = gen_number();
    let password = `${tty.slug()}-${tty.shortId()}`;

    return {
        community_name,
        name,
        email,
        phone_number,
        password,
        tos: true
    };
}

let gen_person = () => {
    let name = tty.name();
    let email = tty.email();
    let phone_number = gen_number();
    let password = `${tty.slug()}-${tty.shortId()}`;

    return {
        name,
        email,
        phone_number,
        password,
        tos: true
    };
}

let withCommunity = async ({verified=false}={}) => {
    let fetch = makeFetchHappen();
    let community = gen_community();

    let resp = await fetch('api/community', {
        method: 'POST',
        body: JSON.stringify(community)
    });
    let json = await resp.json();
    let community_slug = json.community_slug;
    assert.equal(resp.status, 200);

    // verify the community owner's phone number and email
    //  (with a little hack)
    if(verified) {
        let res = await fetch(`api/community/${community_slug}/force/verify`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        if(res.status !== 200) {
            console.log(await res.text());
            assert.fail('could not verify community');
        }

        res = await fetch(`api/community/${community_slug}/auth`);
        json = await res.json();
        assert.equal(res.status, 200);
    }

    // also: get the community owner's user info
    resp = await fetch(`api/community/${community_slug}/auth`);
    let ownerSession = await resp.json();
    let ownerId = ownerSession.user_id;

    assert.equal(resp.status, 200);

    return {
        community,
        community_slug,
        userId: ownerId,
        fetch,
    }
}

let withSupercommunity = async () => {
    // so, there's a special community called "admin"
    //  it should ALWAYS exist
    let fetch = makeFetchHappen();
    let password = `adminterface`;
    let email = `admin@example.com`
    let community_slug = 'admin';

    let resp = await fetch('api/community/admin');
    //it might not exist YET
    if(resp.status === 404) {
        let community = {
            community_name: "Admin",
            name: "Major Pencilbunch",
            email,
            phone_number: `15555555555`,
            password,
            tos: true
        };

        resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        assert.equal(resp.status, 200);

        let res = await fetch(`api/community/${community_slug}/force/verify`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        if(res.status !== 200) {
            console.log(await res.text());
            assert.fail('could not verify community');
        }

        res = await fetch(`api/community/${community_slug}/auth`);
        json = await res.json();
        assert.equal(res.status, 200);
    }
    else {
        // if it exists, log in as superadmin
        resp = await fetch(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                email,
                password,
            }),
        });
        assert.equal(resp.status, 200);
    }

    // also: get the supercommunity's user info
    resp = await fetch(`api/community/${community_slug}/auth`);
    let superSession = await resp.json();
    let userId = superSession.user_id;

    assert.equal(resp.status, 200);

    return {
        fetch,
        community_slug: 'admin',
        userId,
        session: superSession,
    };
}

let withUser = async ({fetch, community_slug, verified=false, admin=false, withSocket=false}) => {
    let resp = await fetch(`api/community/${community_slug}/invite`, {
        method: 'POST',
        body: JSON.stringify({use_type: 'unlimited'}),
    });
    assert.equal(resp.status, 200);
    let json = await resp.json();
    let invite_code = json.invite_code;

    let community2 = gen_community();
    let new_person = {
        name: community2.name,
        phone_number: community2.phone_number,
        password: community2.password,
        tos: true,
    }

    let fetch2 = makeFetchHappen();
    resp = await fetch2(`api/community/${community_slug}/invite/${invite_code}`, {
        method: 'POST',
        body: JSON.stringify(new_person),
    });
    assert.equal(resp.status, 200);
    json = await resp.json();
    assert.strictEqual(json.community_slug, community_slug);

    if(verified) {
        let res = await fetch2(`api/community/${community_slug}/force/verify`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        if(res.status !== 200) {
            console.log(await res.text());
            assert.fail('could not verify user');
        }
    }

    if(admin) {
        let res = await fetch2(`api/community/${community_slug}/force/admin`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        if(res.status !== 200) {
            console.log(await res.text());
            assert.fail('could not make user admin');
        }
    }

    // get the rest of the user info
    resp = await fetch2(`api/community/${community_slug}/user/${json.user_id}`);
    assert.equal(resp.status, 200);
    json = await resp.json();

    let userId = json.id;

    new_person = {
        ...json,
        ...new_person,
    }

    let messages = [];
    const getSocketMessages = () => {
        let messages_copy = [...messages];
        messages = [];
        return messages_copy;
    }
    let closeSocket = () => {};
    if(withSocket) {
        let cookieString = fetch2.jar.getCookieStringSync(`http://${host}/`);
        //.route("/api/community/{:slug}/live_ws", get(modules::live::routes::live_ws))
        const ws = new WebSocket(`ws://${host}/api/community/${community_slug}/live_ws`, {
            headers: {
                Cookie: cookieString
            },
            origin: `http://${host}`
        });
        ws.on('message', (data) => {
            // console.warn("GOT A WS MESSAGE");
            let msg = null;
            try {
                msg = JSON.parse(data);
                // console.dir(msg);
            } catch(e) {
                console.error("could not parse websocket message", e);
                throw e;
            }
            messages.push(msg);
        });
        closeSocket = () => {
            ws.close();
            ws.removeAllListeners();
            ws.terminate();
        }
    }

    return {fetch: fetch2, new_person, userId, getSocketMessages, closeSocket};
}

withAnonymous = async () => {
    let fetch = makeFetchHappen();
    return {fetch};
}

module.exports = {
    gen_number,
    gen_community,
    gen_person,
    gen_uuid,
    uuid,
    withSupercommunity,
    withCommunity,
    withUser,
    withAnonymous,
}