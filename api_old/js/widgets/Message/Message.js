import { h, render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks'
import { useLocation } from 'preact-iso';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { animate, createScope, createSpring, createDraggable } from 'animejs';

dayjs.extend(relativeTime);

import htm from 'htm';
import UserSpan from '../User/UserSpan.js';
import Button from '../../bips/Button.js';

const html = htm.bind(h);

const Link = ({url, title}) => html`<a href=${url}>${title}</a>`;
const JustAnEmoji = ({emoji}) => html`<span style="font-size: 2em;">${emoji}</span>`;
const Text = ({message}) => html`<p>${message}</p>`;

const Message = ({slug, messageEnvelope, isMe, deleteMessage, seeDuration=2500}) => {

    let { url, path, query, route } = useLocation();

    const containerRef = useRef(null);
    const scope = useRef(null);
    const [seenStarted, setSeenStarted] = useState(false);
    const [seen, setSeen] = useState(messageEnvelope.seen);

    let message = messageEnvelope.message;
    let relativeTime = dayjs(messageEnvelope.created_at).fromNow();
    let seenClass = seen ? "message-seen" : "message-unseen";

    const deleteMess = async () => {
        await deleteMessage(messageEnvelope.id);
    };

    const markAsSeen = async () => {
        try {
            if (seen) return; // Already seen, no need to mark again
            setSeen(true);
            await window.Data.message.markAsSeen({slug, messageId: messageEnvelope.id});
        } catch (error) {
            console.error("Failed to mark message as seen:", error);
        }
    }

    const markAsSeenEventually = async () => {
        try {
            if (seen) return; // Already seen, no need to mark again
            if (seenStarted) return; // Already started the process
            setSeenStarted(true);

            scope.current = createScope({ root: containerRef }).add( self => {
                animate(containerRef.current, {
                    opacity: [1, 0.8],
                    duration: seeDuration,
                    easing: 'linear',
                    onComplete: async () => {
                        // after the animation, call the onDismiss callback
                        await markAsSeen();
                    }
                });
            });

        } catch (error) {
            console.error("Failed to mark message as seen:", error);
        }
    }

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        if (seen) return; // Already seen, no need to observe

        // Mark as seen when the message is in view
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(async entry => {
                if (entry.isIntersecting) {
                    await markAsSeenEventually();
                    observer.unobserve(entry.target);
                }
            });
        });

        observer.observe(el);

        return () => {
            observer.disconnect();
        };
    }, [messageEnvelope.id, messageEnvelope.seen, seen]);


    return html`
    <div ref=${containerRef} class="message ${seenClass}">
        <div class="message-header">
            <div class="user-span"><${UserSpan} isMe=${isMe} userId=${messageEnvelope.user_id} slug=${slug} /></div>
            <div class="message-timestamp">${!seen ? html`<span class="message-new">New!</span>` : ''} <span class='message-relativeTime'>${relativeTime}</span></div>
        </div>
        <div class="message-content">
            ${message.Text ? html`<${Text} message=${message.Text.message} />` : null}
            ${message.Link ? html`<${Link} url=${message.Link.url} title=${message.Link.title} />` : null}
            ${message.JustAnEmoji ? html`<${JustAnEmoji} emoji=${message.JustAnEmoji.emoji} />` : null}
        </div>
    </div>
    `;
}

export default Message;