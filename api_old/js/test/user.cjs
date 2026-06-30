
const assert = require('assert');
const dayjs = require('dayjs');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const makeFetchHappen = require('./fetch.cjs');
const tty = require('testytesterson');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let { gen_community, withCommunity, withSupercommunity, withUser } = require('./generators.cjs');

describe('users', function() {

    it("the generator can make a user verified", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asNewPerson, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        let sessionResp = await asNewPerson(`api/community/${community_slug}/auth`);
        assert.equal(sessionResp.status, 200);
        let json = await sessionResp.json();
        assert(json.user_tags.includes('phone_verified') || json.user_tags.includes('email_verified'));
    });

    it("the generator can make a user an admin", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asNewPerson, new_person } = await withUser({fetch: asOwner, community_slug, verified: true, admin: true});

        let sessionResp = await asNewPerson(`api/community/${community_slug}/auth`);
        assert.equal(sessionResp.status, 200);
        let json = await sessionResp.json();
        assert(json.is_admin);
    });

    it("a community owner needs to validate their phone number and email", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();

        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        let json = await resp.json();
        let community_slug = json.community_slug;
        assert.equal(resp.status, 200);

        let cookies = await fetch.cookies();
        assert(cookies.length > 0);
        assert(cookies.some(cookie => cookie.key.startsWith(`session_${community_slug}`)));

        // when I hit the auth endpoint it should bounce back a session
        resp = await fetch(`api/community/${community_slug}/auth`);
        json = await resp.json();
        assert.equal(resp.status, 200);
        assert(json.user_tags.includes('has_phone'));
        assert(json.user_tags.includes('has_email'));
    });

    it("send a verification code through email", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();

        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        let json = await resp.json();
        let userId = json.user_id;
        let community_slug = json.community_slug;
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/auth/verify/email`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`test/email`);
        assert.equal(resp.status, 200);
        const emails = await resp.json();

        assert(emails.length > 0);
        // the most recent email should be the last one in the list, so we can just check that
        const lastEmail = emails[emails.length - 1];
        assert(lastEmail.to);
        assert(lastEmail.subject);
        assert(lastEmail.message);

        // there should be a code in that email that we can use to validate the email
        let lines = lastEmail.message.split("\n")
        let code_lines = lines[0].split(" ");
        let code = code_lines[ code_lines.length - 1 ];
        assert.strictEqual(code.length, 6);

        let url_lines = lines[1].split(" ");
        let url = url_lines[ url_lines.length - 1 ];
        assert(url.startsWith("http:"));
        assert(url.endsWith(code));

        let fetch2 = makeFetchHappen();

        // validate the email
        resp = await fetch2(`api/community/${community_slug}/auth/verify/email/complete`, {
            method: 'POST',
            body: JSON.stringify({
                user_id: userId,
                code
            }),
        });
        assert.equal(resp.status, 200);
        assert(resp.headers.get("set-cookie").startsWith(`session_${community_slug}=`));

        let cookies = await fetch2.cookies();
        assert(cookies.length > 0);
        assert(cookies.some(cookie => cookie.key.startsWith(`session_${community_slug}`)));

        // the new window should have a session, and that session should have the "email_verified" tag
        resp = await fetch2(`api/community/${community_slug}/auth`);
        json = await resp.json();
        assert.equal(resp.status, 200);
        assert(json.user_tags.includes('has_email'));
        assert(json.user_tags.includes('email_verified'));

    });

    it("send a verification code through sms", async function() {
        let fetch = makeFetchHappen();
        let community = gen_community();

        let resp = await fetch('api/community', {
            method: 'POST',
            body: JSON.stringify(community)
        });
        let json = await resp.json();
        let userId = json.user_id;
        let community_slug = json.community_slug;
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/auth/verify/sms`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`test/sms`);
        assert.equal(resp.status, 200);
        const smss = await resp.json();

        assert(smss.length > 0);
        // the most recent email should be the last one in the list, so we can just check that
        const lastSms = smss[smss.length - 1];
        assert(lastSms.message);

        // there should be a code in that email that we can use to validate the phone number
        let code_lines = lastSms.message.split(" ");
        let code = code_lines[ code_lines.length - 1 ];
        assert.strictEqual(code.length, 6);

        let fetch2 = makeFetchHappen();

        // validate the sms
        resp = await fetch2(`api/community/${community_slug}/auth/verify/sms/complete`, {
            method: 'POST',
            body: JSON.stringify({
                user_id: userId,
                code
            }),
        });
        assert.equal(resp.status, 200);
        assert(resp.headers.get("set-cookie").startsWith(`session_${community_slug}=`));

        let cookies = await fetch2.cookies();
        assert(cookies.length > 0);
        assert(cookies.some(cookie => cookie.key.startsWith(`session_${community_slug}`)));

        // the new window should have a session, and that session should have the "email_verified" tag
        resp = await fetch2(`api/community/${community_slug}/auth`);
        json = await resp.json();
        assert.equal(resp.status, 200);
        assert(json.user_tags.includes('has_phone'));
        assert(json.user_tags.includes('phone_verified'));
    });

    it("a community owner can create a single-use invite code", async function() {
        let { fetch, community_slug } = await withCommunity({verified: true});

        let resp = await fetch(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'once'}),
        });
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.invite_code);
        // it's a uuid
        assert(json.invite_code.length === 36);
    });

    it("invite codes can't be generated for unverified communities", async function() {
        // TODO: this technically just tests that the user is unverified, not the community
        //  doing this properly would require an unverified community with a verified user
        //  which shouldn't even be possible, really?
        let { fetch, community_slug } = await withCommunity({verified: false});

        let resp = await fetch(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'once'}),
        });
        assert.equal(resp.status, 400);
    });

    it("an invite code can be used to create a new user account", async function() {
        let { fetch, community_slug } = await withCommunity({verified: true});

        let resp = await fetch(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'once'}),
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

        // this new person should have a session:
        resp = await fetch2(`api/community/${community_slug}/auth`);
        json = await resp.json();
        //console.dir(json);
        assert.equal(resp.status, 200);
        assert(json.user_tags.includes('has_phone'));
        assert(!json.user_tags.includes('has_email'));
        assert(!json.user_tags.includes('phone_verified'));

        let community3 = gen_community();
        let new_new_person = {
            name: community3.name,
            phone_number: community3.phone_number,
            password: community3.password,
            tos: true,
        }
        let fetch3 = makeFetchHappen();
        resp = await fetch3(`api/community/${community_slug}/invite/${invite_code}`, {
            method: 'POST',
            body: JSON.stringify(new_new_person),
        });
        // this one should fail: the invite code is single-use and has already been used
        assert.equal(resp.status, 404);
        json = await resp.json();
        assert.strictEqual(json.message, 'invite not found');
    });

    it("a community owner can create a multi-use invite code", async function() {
        let { fetch, community_slug } = await withCommunity({verified: true});

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

        // this new person should have a session:
        resp = await fetch2(`api/community/${community_slug}/auth`);
        json = await resp.json();
        //console.dir(json);
        assert.equal(resp.status, 200);
        assert(json.user_tags.includes('has_phone'));
        assert(!json.user_tags.includes('has_email'));
        assert(!json.user_tags.includes('phone_verified'));

        let community3 = gen_community();
        let new_new_person = {
            name: community3.name,
            phone_number: community3.phone_number,
            password: community3.password,
            tos: true,
        }
        let fetch3 = makeFetchHappen();
        resp = await fetch3(`api/community/${community_slug}/invite/${invite_code}`, {
            method: 'POST',
            body: JSON.stringify(new_new_person),
        });
        assert.equal(resp.status, 200);
        json = await resp.json();

        resp = await fetch3(`api/community/${community_slug}/auth`);
        json = await resp.json();
        //console.dir(json);
        assert.equal(resp.status, 200);
        assert(json.user_tags.includes('has_phone'));
        assert(!json.user_tags.includes('has_email'));
        assert(!json.user_tags.includes('phone_verified'));
    });

    it("if a user has verified a phone number, we can't create a new user with that phone number", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

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
            phone_number: community.phone_number, // <- here we're re-using the same phone number
            password: community2.password,
            tos: true,
        }

        let fetch2 = makeFetchHappen();
        resp = await fetch2(`api/community/${community_slug}/invite/${invite_code}`, {
            method: 'POST',
            body: JSON.stringify(new_person),
        });
        // this 400s: the phone number is already in use
        assert.equal(resp.status, 400);
    });

    it("if a user has verified an email, we can't create a new user with that email", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

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
            email: community.email, // <- here we're re-using the same email
            password: community2.password,
            tos: true,
        }

        let fetch2 = makeFetchHappen();
        resp = await fetch2(`api/community/${community_slug}/invite/${invite_code}`, {
            method: 'POST',
            body: JSON.stringify(new_person),
        });
        // this 400s: the email is already in use
        assert.equal(resp.status, 400);
    });

    it("get a list of invite codes", async function() {
        let { fetch, community_slug } = await withCommunity({verified: true});

        let resp = await fetch(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'unlimited'}),
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'once'}),
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'once'}),
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/invite`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.length === 3);
    });

    it("delete an invite code", async function() {
        let { fetch, community_slug } = await withCommunity({verified: true});

        let resp = await fetch(`api/community/${community_slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({use_type: 'unlimited'}),
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/invite`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.length === 1);
        let invite_code = json[0].invite_code;

        resp = await fetch(`api/community/${community_slug}/invite/${invite_code}`, {
            method: 'DELETE',
        });
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/invite`);
        assert.equal(resp.status, 200);
        json = await resp.json();
        assert(json.length === 0);
    });

    it("log in as a user with phone number and password", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

        let fetch2 = makeFetchHappen();
        let resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);

        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number: community.phone_number,
                password: community.password,
            }),
        });
        assert.equal(resp.status, 200);

        resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
    });

    it("log in as a user with phone number and password, but phone number has no dashes", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

        // remove the first character from the phone number
        let busted_phone_numbers = [];
        busted_phone_numbers.push(community.phone_number);
        busted_phone_numbers.push(community.phone_number.slice(1));
        // add dashes, so "18005552222" becomes "1-800-555-2222"
        busted_phone_numbers.push("1-" + community.phone_number.slice(1, 4) + "-" + community.phone_number.slice(4, 7) + "-" + community.phone_number.slice(7));
        busted_phone_numbers.push(community.phone_number.slice(1, 4) + "-" + community.phone_number.slice(4, 7) + "-" + community.phone_number.slice(7));

        for(let phone_number of busted_phone_numbers){
            let fetch2 = makeFetchHappen();
            let resp = await fetch2(`api/community/${community_slug}/auth`);
            assert.equal(resp.status, 400);

            resp = await fetch2(`api/community/${community_slug}/login`, {
                method: 'POST',
                body: JSON.stringify({
                    phone_number,
                    password: community.password,
                }),
            });
            assert.equal(resp.status, 200);

            resp = await fetch2(`api/community/${community_slug}/auth`);
            assert.equal(resp.status, 200);
        }

    });

    it("log in as a user with phone number and bad password", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

        let fetch2 = makeFetchHappen();
        let resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);

        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number: community.phone_number,
                password: "farts ahoy",
            }),
        });
        assert.equal(resp.status, 400);
    });

    it("log in as a user with phone number and no password", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

        let fetch2 = makeFetchHappen();
        let resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);

        resp = await fetch2(`api/community/${community_slug}/login/token`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number: community.phone_number,
            }),
        });
        assert.equal(resp.status, 200);
        let userId = (await resp.json()).userId;
        assert(userId);

        // this sends a token to the phone number
        resp = await fetch(`test/sms`);
        assert.equal(resp.status, 200);
        const smss = await resp.json();

        assert(smss.length > 0);
        // the most recent email should be the last one in the list, so we can just check that
        const lastSms = smss[smss.length - 1];
        assert(lastSms.message);

        let code_lines = lastSms.message.split(" ");
        let code = code_lines[ code_lines.length - 1 ];
        assert.strictEqual(code.length, 6);

        // use the SMS token to log in
        resp = await fetch2(`api/community/${community_slug}/login/token/complete?user_id=${userId}&code=${code}`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        assert.equal(resp.status, 200);
        assert(resp.headers.get("set-cookie").startsWith(`session_${community_slug}=`));

        // the person is logged in
        resp = await fetch2(`api/community/${community_slug}/auth`);
        json = await resp.json();
        assert.equal(resp.status, 200);
    });

    it("log in as a user with email and no password", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

        let fetch2 = makeFetchHappen();
        let resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);

        resp = await fetch2(`api/community/${community_slug}/login/token`, {
            method: 'POST',
            body: JSON.stringify({
                email: community.email,
            }),
        });
        assert.equal(resp.status, 200);
        let userId = (await resp.json()).userId;
        assert(userId);

        // this sends a token to the phone number
        resp = await fetch(`test/email`);
        assert.equal(resp.status, 200);
        const emails = await resp.json();

        // the most recent email should be the last one in the list, so we can just check that
        const lastEmail = emails[emails.length - 1];
        assert(lastEmail.to);
        assert(lastEmail.subject);
        assert(lastEmail.message);

        // there should be a code in that email that we can use to validate the email
        let lines = lastEmail.message.split("\n")
        let code_lines = lines[0].split(" ");
        let code = code_lines[ code_lines.length - 1 ];
        assert.strictEqual(code.length, 6);

        // use the SMS token to log in
        resp = await fetch2(`api/community/${community_slug}/login/token/complete?user_id=${userId}&code=${code}`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        assert.equal(resp.status, 200);
        assert(resp.headers.get("set-cookie").startsWith(`session_${community_slug}=`));

        // the person is logged in
        resp = await fetch2(`api/community/${community_slug}/auth`);
        json = await resp.json();
        assert.equal(resp.status, 200);
    });

    it("log in as a user with email and password", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

        let fetch2 = makeFetchHappen();
        let resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);

        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                email: community.email,
                password: community.password,
            }),
        });
        assert.equal(resp.status, 200);

        resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
    });

    it("log in as a user with email and bad password", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

        let fetch2 = makeFetchHappen();
        let resp = await fetch2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);

        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                email: community.email,
                password: "bad password",
            }),
        });
        assert.equal(resp.status, 400);
    });

    it("logout", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});

        let resp = await fetch(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/logout`);
        assert.equal(resp.status, 200);

        resp = await fetch(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);
    });

    it("get a list of users", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});
        await withUser({fetch, community_slug, verified: true});
        await withUser({fetch, community_slug, verified: true});
        let {fetch: fetch2} = await withUser({fetch, community_slug, verified: true});

        let resp = await fetch(`api/community/${community_slug}/users`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.length === 4);

        assert(json[0].id);
        assert(json[0].name);
        assert(json[0].slug);
        //assert(json[0].phone_number); // the system won't show the phone number anymore, it's private
        assert(json[0].tags.includes('has_phone'));
        assert(json[0].tags.includes('phone_verified'));
        assert(json[0].created_at)
        assert(json[0].updated_at)

        // any user from the community can see the list of users
        resp = await fetch2(`api/community/${community_slug}/users`);
        assert.equal(resp.status, 200);

    });

    it("get a single user", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});
        await withUser({fetch, community_slug, verified: true});
        await withUser({fetch, community_slug, verified: true});
        await withUser({fetch, community_slug, verified: true});

        let resp = await fetch(`api/community/${community_slug}/users`);
        assert.equal(resp.status, 200);
        let json = await resp.json();

        let id = json[3].id;

        resp = await fetch(`api/community/${community_slug}/user/${id}`);
        assert.equal(resp.status, 200);

        let user = await resp.json();

        assert(user.id);
        assert(user.name);
        assert(user.slug);
        //assert(user.phone_number);
        assert(user.tags.includes('has_phone'));
        assert(user.tags.includes('phone_verified'));
        assert(user.created_at)
        assert(user.updated_at)
    });

    it("delete a user", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        await withUser({fetch: asOwner, community_slug, verified: true});
        await withUser({fetch: asOwner, community_slug, verified: true});
        await withUser({fetch: asOwner, community_slug, verified: true});

        let resp = await asOwner(`api/community/${community_slug}/users`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.length === 4);

        let owner = json.find(u => u.tags.includes('owner'));
        let everyoneElse = json.filter(u => !u.tags.includes('owner'));
        let userToDeleteId = everyoneElse[0].id

        // the owner can't be deleted
        resp = await asOwner(`api/community/${community_slug}/user/${owner.id}`, {
            method: 'DELETE',
        });
        assert.equal(resp.status, 400);

        // the owner can delete the user
        resp = await asOwner(`api/community/${community_slug}/user/${userToDeleteId}`, {
            method: 'DELETE',
        });
        assert.equal(resp.status, 200);


        resp = await asOwner(`api/community/${community_slug}/users`);
        assert.equal(resp.status, 200);
        json = await resp.json();
        // boom goes the dynamite
        assert(json.length === 3);
    });

    it("a user changes their password", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch, community_slug, verified: true});

        let resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);

        resp = await asUser(`api/community/${community_slug}/auth/change/password`, {
            method: 'POST',
            body: JSON.stringify("new password"),
        });
        assert.equal(resp.status, 200);

        let fetch2 = makeFetchHappen();
        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number: new_person.phone_number,
                password: "new password",
            }),
        });
        assert.equal(resp.status, 200);
    });

    it("a user changes their email", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch, community_slug, verified: true});
        let { email } = gen_community();

        let resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        let userId = json.user_id;

        resp = await asUser(`api/community/${community_slug}/auth/change/email`, {
            method: 'POST',
            body: JSON.stringify(email),
        });
        assert.equal(resp.status, 200);

        // until we verify the email, we can't log in with it
        let fetch2 = makeFetchHappen();
        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                email,
                password: new_person.password,
            }),
        });
        assert.equal(resp.status, 404);

        // verify the email
        resp = await fetch(`test/email`);
        assert.equal(resp.status, 200);
        const emails = await resp.json();
        // the most recent email should be the last one in the list, so we can just check that
        const lastEmail = emails[emails.length - 1];
        let verification_code = lastEmail.message.match(/(\d{6})/)[0];

        resp = await fetch(`api/community/${community_slug}/auth/verify/email/complete`,{
            method: 'POST',
            body: JSON.stringify({
                user_id: userId,
                code: verification_code,
            })
        });
        assert.equal(resp.status, 200);

        // now we can log in with the new email
        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                email,
                password: new_person.password,
            }),
        });
        assert.equal(resp.status, 200);
    });

    it("a user changes their phone number", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch, community_slug, verified: true});
        let { phone_number } = gen_community();

        let resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        let userId = json.user_id;

        resp = await asUser(`api/community/${community_slug}/auth/change/phone`, {
            method: 'POST',
            body: JSON.stringify(phone_number),
        });
        assert.equal(resp.status, 200);

        // until we verify the phone number, we can't log in with it
        let fetch2 = makeFetchHappen();
        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number,
                password: new_person.password,
            }),
        });
        assert.equal(resp.status, 404);

        // verify the phone number
        resp = await fetch(`test/sms`);
        assert.equal(resp.status, 200);
        const smss = await resp.json();
        // the most recent email should be the last one in the list, so we can just check that
        const lastSms = smss[smss.length - 1];
        let verification_code = lastSms.message.match(/(\d{6})/)[0];

        resp = await fetch(`api/community/${community_slug}/auth/verify/sms/complete`, {
            method: 'POST',
            body: JSON.stringify({
                user_id: userId,
                code: verification_code,
            }),
        });
        assert.equal(resp.status, 200);

        // now we can log in with the new phone number
        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number,
                password: new_person.password,
            }),
        });
        assert.equal(resp.status, 200);
    });

    it("a user changes their name", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch, community_slug, verified: true});

        let resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);

        resp = await asUser(`api/community/${community_slug}/auth/change/name`, {
            method: 'POST',
            body: JSON.stringify("Sburbo McFartnation"),
        });
        assert.equal(resp.status, 200);

        resp = await asUser(`api/community/${community_slug}/auth`);
        let json = await resp.json();
        assert.strictEqual(json.user_name, "Sburbo McFartnation");
        assert.strictEqual(json.user_slug, "sburbo-mcfartnation");

        // get the user by their new slug
        resp = await fetch(`api/community/${community_slug}/slug/sburbo-mcfartnation`);
        assert.equal(resp.status, 200);
        json = await resp.json();
        assert.strictEqual(json.name, "Sburbo McFartnation");
    });

    it("a user can't change their name to an empty string", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch, community_slug, verified: true});

        let resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);

        resp = await asUser(`api/community/${community_slug}/auth/change/name`, {
            method: 'POST',
            body: JSON.stringify(""),
        });
        assert.equal(resp.status, 400);
        let json = await resp.json();
        assert.strictEqual(json.message, "Name cannot be empty.");
    });

    it("every time a user logs in, their last_login is updated", async function() {
        let { fetch, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch, community_slug, verified: true});

        let resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        let json = await resp.json();

        resp = await asUser(`api/community/${community_slug}/user/${json.user_id}`);
        assert.equal(resp.status, 200);
        json = await resp.json();
        let last_login_string = json.last_login;
        assert(last_login_string);

        let last_login_date = dayjs(last_login_string);
        assert(last_login_date.isValid());

        // log in again
        resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        json = await resp.json();

        // get the user again
        resp = await asUser(`api/community/${community_slug}/user/${json.user_id}`);
        assert.equal(resp.status, 200);
        json = await resp.json();
        let new_last_login_string = json.last_login;
        assert(new_last_login_string);
        let new_last_login_date = dayjs(new_last_login_string);
        assert(new_last_login_date.isValid());
        assert(new_last_login_date.isAfter(last_login_date), "new last login should be after old last login");
    });

    it("an owner has the is_admin boolean set to true on their session, and a regular user does not", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        let resp = await asOwner(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.is_admin);

        resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        json = await resp.json();
        assert(!json.is_admin);
    });

    it("an owner can lock a user, after which they can't log in", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        let resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);

        // the user can not lock or unlock themselves
        resp = await asUser(`api/community/${community_slug}/user/${new_person.id}/lock`, {
            method: 'POST',
        });
        assert.equal(resp.status, 400);
        let json = await resp.json();
        assert(json.message.includes("admin"));

        // lock the user
        resp = await asOwner(`api/community/${community_slug}/user/${new_person.id}/lock`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        // flush the event queue
        resp = await asUser(`api/admin/flush`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        // try to log in again: it won't work, not only can the user no longer log in, but the session is invalidated
        resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 400);
        let json2 = await resp.json();
        assert.strictEqual(json2.message, "Session not valid.");

        // try to log in with the phone number and password
        let fetch2 = makeFetchHappen();
        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number: new_person.phone_number,
                password: new_person.password,
            }),
        });
        assert.equal(resp.status, 400);
        json = await resp.json();
        assert.strictEqual(json.message, "User is locked.");

        // try to log in with the phone number, via token
        resp = await fetch2(`api/community/${community_slug}/login/token`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number: new_person.phone_number,
            }),
        });
        assert.equal(resp.status, 400);
        json = await resp.json();
        assert.strictEqual(json.message, "User is locked.");

        // remove the lock
        resp = await asOwner(`api/community/${community_slug}/user/${new_person.id}/unlock`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        // the user can log in again
        resp = await fetch2(`api/community/${community_slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                phone_number: new_person.phone_number,
                password: new_person.password,
            }),
        });
        assert.equal(resp.status, 200);
        json = await resp.json();

        assert.strictEqual(json.user_id, new_person.id);
    });

    it("an owner can make a user an admin, and then they can make another user an admin", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        // the user can not make themselves an admin
        let resp = await asUser(`api/community/${community_slug}/user/${new_person.id}/admin`, {
            method: 'POST',
        });
        assert.equal(resp.status, 400);
        let json = await resp.json();
        assert(json.message.includes("admin"));

        // make the user an admin
        resp = await asOwner(`api/community/${community_slug}/user/${new_person.id}/admin`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        // the user has to at least log in again
        resp = await asUser(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        json = await resp.json();
        assert(json.is_admin);

        // now that they're an admin, they can make another user an admin
        let { fetch: asUser2, new_person: new_person2 } = await withUser({fetch: asOwner, community_slug, verified: true});
        resp = await asUser(`api/community/${community_slug}/user/${new_person2.id}/admin`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        // the new user is now an admin
        resp = await asUser2(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        json = await resp.json();
        assert(json.is_admin);
    });

    it("let's get a list of only admin users", async function() {
        let { fetch: asOwner, community_slug } = await withCommunity({verified: true});
        // make 2 admin users and 2 regular users
        await withUser({fetch: asOwner, community_slug, verified: true, admin: true});
        await withUser({fetch: asOwner, community_slug, verified: true, admin: true});
        await withUser({fetch: asOwner, community_slug, verified: true, admin: false});
        await withUser({fetch: asOwner, community_slug, verified: true, admin: false});

        let usersResp = await asOwner(`api/community/${community_slug}/admin_users`);
        assert.equal(usersResp.status, 200);
        let usersJson = await usersResp.json();
        assert.strictEqual(usersJson.length, 3);
        assert(usersJson.map(x => x.tags).every(tags => tags.includes('owner') || tags.includes('admin')));
    });

    it("a supercommunity exists", async function() {
        let { fetch: asSupercommunity, community: supercommunity, community_slug: supercommunity_slug } = await withSupercommunity();

        let resp = await asSupercommunity(`api/community/${supercommunity_slug}/auth`);
        assert.equal(resp.status, 200);
    });

    it("if a supercommunity user tries to log into any other community, it succeeds, because SPECIAL MAGIC POWERS", async function() {
        let { fetch: asSupercommunity, community_slug: supercommunity_slug, userId: superUserId } = await withSupercommunity();
        let { fetch: asCommunity, community_slug: normalcommunity_slug } = await withCommunity({verified: true});

        // note, here, we're using the supercommunity fetch to access the normal non-super community
        let resp = await asSupercommunity(`api/community/${normalcommunity_slug}/auth`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.is_admin);

        // also: that community is permanently poisoned by the presence of the supercommunity user
        resp = await asSupercommunity(`api/community/${normalcommunity_slug}/users`);
        let normalcommunityUsers = await resp.json();

        // one of the users in that community is the supercommunity user
        let found = normalcommunityUsers.find(u => u.id === superUserId);
        assert(found, "should find the supercommunity user in the normal community");
    });

    it("a supercommunity user can touch a community without having it create an automatic user", async function() {
        let { fetch: asSupercommunity, community_slug: supercommunity_slug, userId: superUserId } = await withSupercommunity();
        let { fetch: asCommunity, community_slug: normalcommunity_slug } = await withCommunity({verified: true});

        let resp = await asSupercommunity(`api/community/${normalcommunity_slug}/auth?touch=true`);
        assert.equal(resp.status, 200);

        // that community is NOT permanently poisoned by the presence of the supercommunity user
        resp = await asSupercommunity(`api/community/${normalcommunity_slug}/users`);
        let normalcommunityUsers = await resp.json();

        // one of the users in that community is not the supercommunity user
        let found = normalcommunityUsers.find(u => u.id === superUserId);
        assert(!found, "should not find the supercommunity user in the normal community");
    });

    it("an admin can't see its community's user emails or phone numbers", async function() {
        let { fetch: asOwner, community, community_slug, userId: ownerId } = await withCommunity({verified: true});
        let { fetch: asUser, userId: newPersonId } = await withUser({fetch: asOwner, community_slug, verified: true});

        let resp = await asOwner(`api/community/${community_slug}/users`);
        assert.equal(resp.status, 200);
        let json = await resp.json();

        // I can see my OWN email and phone number
        let owner = json.find(u => u.id === ownerId);
        assert(owner.email);
        assert(owner.phone_number);

        let otherUser = json.find(u => u.id === newPersonId);
        assert(otherUser);
        assert(otherUser.tags.includes('has_phone'));
        assert(!otherUser.email);
        assert(!otherUser.phone_number);

        resp = await asOwner(`api/community/${community_slug}/user/${newPersonId}`);
        assert.equal(resp.status, 200);
        let userJson = await resp.json();
        assert(userJson);
        assert(userJson.tags.includes('has_phone'));
        assert(!userJson.email);
        assert(!userJson.phone_number);
    });

    it("we can look up this user with webfinger", async function() {
        let asAnybody = makeFetchHappen();
        let { fetch: asOwner, community_slug } = await withCommunity({verified: true});

        // get the user's details:
        let resp = await asOwner(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        let user_slug = json.user_slug;

        let acct = `${user_slug}:${community_slug}@local.groovelet.com`;

        resp = await asAnybody(`.well-known/webfinger?resource=acct:${acct}`);
        assert.equal(resp.status, 200);

        json = await resp.json();

        assert.strictEqual(json.subject, `acct:${acct}`);

        assert(json.links.some(link => link.rel === "self"));
        let self_link = json.links.find(link => link.rel === "self");
        assert.strictEqual(self_link.type, "application/activity+json");
        assert(self_link.href.endsWith(`/api/community/${community_slug}/user/${user_slug}/actor`));

        assert(json.links.some(link => link.rel === "http://webfinger.net/rel/profile-page"));
        let profile_link = json.links.find(link => link.rel === "http://webfinger.net/rel/profile-page");
        assert(profile_link.href.endsWith(`/community/${community_slug}/user/${user_slug}`));
        assert.strictEqual(profile_link.type, "text/html");

        assert(json.links.some(link => link.rel === "http://webfinger.net/rel/avatar"));
        let avatar_link = json.links.find(link => link.rel === "http://webfinger.net/rel/avatar");
        assert(avatar_link.href.includes(`/api/community/${community_slug}/user/${user_slug}/avatar`));

        assert(json.links.some(link => link.rel === "http://ostatus.org/schema/1.0/subscribe"));

        // this also works if we use the alternate acct format
        acct = `${user_slug}@${community_slug}.local.groovelet.com`;

        resp = await asAnybody(`.well-known/webfinger?resource=acct:${acct}`);
        assert.equal(resp.status, 200);

        // it's basically the same output, no need to look closely
        json = await resp.json();
        assert.strictEqual(json.subject, `acct:${acct}`);

        // 404 if the user doesn't exist
        acct = `nonexistentuser:${community_slug}@local.groovelet.com`;
        resp = await asAnybody(`.well-known/webfinger?resource=acct:${acct}`);
        assert.equal(resp.status, 404);

        // 404 if the community doesn't exist
        acct = `${user_slug}:nonexistentcommunity@local.groovelet.com`;
        resp = await asAnybody(`.well-known/webfinger?resource=acct:${acct}`);
        assert.equal(resp.status, 404);
    });

    it("we can look up a user's actor object", async function() {
        let { fetch: asOwner, community_slug } = await withCommunity({verified: true});

        // get the user's details:
        let resp = await asOwner(`api/community/${community_slug}/auth`);
        assert.equal(resp.status, 200);
        let json = await resp.json();
        let user_slug = json.user_slug;

        resp = await asOwner(`api/community/${community_slug}/user/${user_slug}/actor`);
        assert.equal(resp.status, 200);
        json = await resp.json();

        console.dir(json, {depth: null});
        // it's not quite right yet - it's missing some fields - but it's a start


    });

    // edge case: someone could learn community emails and phone numbers by simply trying to log in repeatedly and seeing if the error message changes
    //  we should rate limit everything (as a matter of basic security)
    //  but also consider more generic auth messaging to avoid this kind of information leakage
    //  but this is a problem for when we have literally any users, so we'll just leave it for now
});