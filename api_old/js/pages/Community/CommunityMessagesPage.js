import { h, Component, render, createRef } from 'preact';
import { useState, useEffect } from 'preact/hooks'
import htm from 'htm';
import { useLocation } from 'preact-iso';

const html = htm.bind(h);

import CommunityHomePageLayout from './CommunityHomePageLayout.js';
import Alert from '../../bips/Alert.js';
import User from '../../widgets/User/User.js';
import Button from '../../bips/Button.js';
import Message from '../../widgets/Message/Message.js';

const NullMessages = () => html`
    <${Alert} variant="null" title="Quiet. Too Quiet." message="No messages to display." />`;

const CommunityMessagesPage = ({slug}) => {

    let [error, setError] = useState(null);
    let [session, setSession] = useState(null);
    let [messages, setMessages] = useState([]);
    let [loading, setLoading] = useState(true);
    let { url, path, query, route } = useLocation();

    useEffect(() => {
        // Fetch messages from the API
        const fetchMessages = async () => {
            try {
                let session = await window.Data.session.getSession({slug});
                setSession(session);
                let messages = await window.Data.message.getMessages({slug});
                setMessages(messages);
                window.Data.live.on("MessagesChanged", async () => {
                    // reloading messages!
                    let messages = await window.Data.message.getMessages({slug});
                    console.dir(messages);
                    setMessages(messages);
                });
            } catch (e) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        };
        fetchMessages();
    }, []);

    const sendSampleMessages = async () => {
        try {
            // send 3 messages to myself
            let options = ["Gyre", "Gimble", "In the wabe", "All mimsy were the borogoves", "And the mome raths outgrabe",
                    "Beware the Jubjub bird, and shun", "The frumious Bandersnatch", "He took his vorpal sword in hand",
                    "Long time the manxome foe he sought", "So rested he by the Tumtum tree", "And stood awhile in thought",
                    "And as in uffish thought he stood", "The Jabberwock, with eyes of flame", "Came whiffling through the tulgey wood",
                    "And burbled as it came!"];
            let randomOption = () => options[Math.floor(Math.random() * options.length)];
            await window.Data.message.sendMessage({slug, userId: session.user_id, content: {
                Text: {
                    message: "Hello! " + randomOption()
                }
            }});
        } catch (e) {
            setError(e.message);
        }
    };

    const deleteMessage = async (messageId) => {
        try {
            await window.Data.message.deleteMessage({slug, messageId});
            setMessages(messages.filter(m => m.id !== messageId));
        } catch (e) {
            setError(e.message);
        }
    }

    return html`
    <${CommunityHomePageLayout} loading=${loading} slug=${slug} pageName="Messages">
        <h2>Messages</h2>

        <!--<${Button} onClick=${sendSampleMessages}>Send Sample Messages<//>-->

        <${Alert} type="error" message=${error} />

        ${messages.length > 0 ? messages.map(messageEnvelope => html`
            <${Message} key=${messageEnvelope.id} messageEnvelope=${messageEnvelope} deleteMessage=${deleteMessage} slug=${slug} isMe=${session.user_id === messageEnvelope.user_id}/>`) : html`<${NullMessages} />`}
    <//>
    `;
}

export default CommunityMessagesPage;