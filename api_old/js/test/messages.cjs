const assert = require('assert');
const dayjs = require('dayjs');
const dns = require('node:dns');
const delay = ms => new Promise(res => setTimeout(res, ms));

dns.setDefaultResultOrder('ipv4first');

let { withCommunity, withUser, uuid } = require('./generators.cjs');

describe('messages', function() {

    it("we can send a message: the target user will have received that message", async function() {
        /*
        pub enum Message {
            Link {
                url: String,
                title: Option<String>,
            },
            Text {
                message: String,
            },
            JustAnEmoji {
                emoji: String,
            },
        }
        pub struct CreateMessagePayload {
            pub target_user_id: Uuid,
            pub message: super::Message,
        }
        // POST /community/:slug/admin/messages

        rust serde will unpack the message from a JSON object like this:
        {
            "target_user_id": "uuid",
            "message": {
                "Link": {
                    "url": "https://example.com",
                    "title": "Example"
                }
            }
        }

        */

        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        let resp = await asOwner(`api/community/${community_slug}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                target_user_id: new_person.id,
                message: {
                    Link: {
                        url: "https://example.com",
                        title: "Example"
                    }
                }
            }),
        });
        assert.equal(resp.status, 200);
        let json = await resp.json();
        assert(json.message.includes("created"));

        // get messages for the user
        resp = await asUser(`api/community/${community_slug}/messages`);
        assert.equal(resp.status, 200);
        let messages = await resp.json();
        assert(Array.isArray(messages));
        assert(messages.length > 0);

        let message = messages[0];
        assert(message.id);
        assert.equal(message.user_id, new_person.id);
        assert(message.source_user_id);
        assert.equal(message.message.Link.url, "https://example.com");
        assert.equal(message.message.Link.title, "Example");
        assert(message.created_at);
        assert(message.created_at_int);
        let timestamp = message.created_at_int;

        // get the count of unseen messages for the user
        resp = await asUser(`api/community/${community_slug}/messages/count`);
        assert.equal(resp.status, 200);
        let count_json = await resp.json();
        assert(count_json >= 1);

        // send an AdminOnlyMessage
        resp = await asOwner(`api/community/${community_slug}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                target_user_id: new_person.id,
                message: {
                    AdminOnlyMessage: {
                        message: "This is an admin-only message"
                    }
                }
            }),
        });
        assert.equal(resp.status, 200);

        // get messages for the user again
        resp = await asUser(`api/community/${community_slug}/messages/after/${timestamp}`);
        assert.equal(resp.status, 200);
        messages = await resp.json();
        assert(messages.length > 0);
        assert.strictEqual(messages[0].message.AdminOnlyMessage.message, "This is an admin-only message");

        // get message history between the owner and the user
        resp = await asOwner(`api/community/${community_slug}/messages/with/${new_person.id}`);
        assert.equal(resp.status, 200);
        messages = await resp.json();
        assert(messages.length >= 2); // at least the two messages we just sent
        assert.strictEqual(messages[0].message.AdminOnlyMessage.message, "This is an admin-only message");
        assert.strictEqual(messages[1].message.Link.url, "https://example.com");
        let ownerId = messages[0].source_user_id;

        // count the message history between the owner and the user
        // the owner has sent 2 messages to the user, but received just the one: "A user you invited to the community has signed up!"
        resp = await asOwner(`api/community/${community_slug}/messages/from/${new_person.id}/count`);
        messageCount = await resp.json();
        assert.equal(messageCount, 1);
        assert.equal(resp.status, 200);

        resp = await asUser(`api/community/${community_slug}/messages/from/${ownerId}/count`);
        messageCount = await resp.json();
        assert.equal(messageCount, 2);
        assert.equal(resp.status, 200);

        // get message history after a certain timestamp
        resp = await asOwner(`api/community/${community_slug}/messages/with/${new_person.id}/after/${timestamp}`);
        assert.equal(resp.status, 200);
        messages = await resp.json();
        assert(messages.length >= 1);
        assert.strictEqual(messages[0].message.AdminOnlyMessage.message, "This is an admin-only message");

    });

    it("if we send a message to a user who does not exist, we get an error", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});

        let resp = await asOwner(`api/community/${community_slug}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                target_user_id: uuid(),
                message: {
                    Link: {
                        url: "https://example.com",
                        title: "Example"
                    }
                }
            }),
        });
        assert.equal(resp.status, 400);
        let json = await resp.json();
        assert(json.message.includes("does not exist"));
    });

    it("A regular user can send a message, but cannot send an AdminOnlyMessage", async function() {
        let { fetch: asOwner, community, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        // regular user sends a message
        let resp = await asUser(`api/community/${community_slug}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                target_user_id: new_person.id,
                message: {
                    Text: {
                        message: "Hello from a regular user"
                    }
                }
            }),
        });
        assert.equal(resp.status, 200);

        // regular user tries to send an AdminOnlyMessage
        resp = await asUser(`api/community/${community_slug}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                target_user_id: new_person.id,
                message: {
                    AdminOnlyMessage: {
                        message: "This should not be allowed"
                    }
                }
            }),
        });
        assert.equal(resp.status, 400);
        let json = await resp.json();
        assert(json.message.includes("cannot send this type of message"));
    });

    it("if we create a a connection, then get events for that connection, we get a message update if we've been sent a message", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person } = await withUser({fetch: asOwner, community_slug, verified: true});

        // create a connection
        let resp = await asUser(`api/community/${community_slug}/live`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);
        let json = await resp.json();
        let connection_id = json;
        assert(connection_id);

        // get events for that connection - should be empty
        //.route("/api/community/{:slug}/live/{:connection_id}/events", get(modules::live::routes::get_live_events))
        resp = await asUser(`api/community/${community_slug}/live/${connection_id}/events`);
        assert.equal(resp.status, 200);
        let events = await resp.json();
        assert(events.length === 0);

        // send a message to the user
        resp = await asOwner(`api/community/${community_slug}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                target_user_id: new_person.id,
                message: {
                    Link: {
                        url: "https://example.com",
                        title: "Example"
                    }
                }
            }),
        });
        assert.equal(resp.status, 200);

        // flush the event queue
        resp = await asUser(`api/admin/flush`, {
            method: 'POST',
        });
        assert.equal(resp.status, 200);

        // get events for that connection - should have one event
        resp = await asUser(`api/community/${community_slug}/live/${connection_id}/events`);
        assert.equal(resp.status, 200);
        events = await resp.json();
        assert(events.length === 1);
        assert(events[0] == "MessagesChanged");

        // get events for that connection - this time it should be empty again: we just fetched the event
        resp = await asUser(`api/community/${community_slug}/live/${connection_id}/events`);
        assert.equal(resp.status, 200);
        events = await resp.json();
        assert(events.length === 0);

    });

    it("if we create a websocket connection, then send a message, we get a message update over the websocket", async function() {
        let { fetch: asOwner, community: _, community_slug } = await withCommunity({verified: true});
        let { fetch: asUser, new_person, getSocketMessages, closeSocket } = await withUser({fetch: asOwner, community_slug, verified: true, withSocket: true});

        try{
            // send a message to the user
            resp = await asOwner(`api/community/${community_slug}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    target_user_id: new_person.id,
                    message: {
                        Link: {
                            url: "https://example.com",
                            title: "Example"
                        }
                    }
                }),
            });
            assert.equal(resp.status, 200);

            // flush the event queue
            resp = await asUser(`api/admin/flush`, {
                method: 'POST',
            });
            assert.equal(resp.status, 200);

            await delay(500); // give the websocket a moment to receive the message
            let socketMessages = await getSocketMessages();
            // one of the messages is "MessagesChanged"
            assert(socketMessages.find(m => m == "MessagesChanged"));
        }
        finally {
            closeSocket();
        }
    });

});