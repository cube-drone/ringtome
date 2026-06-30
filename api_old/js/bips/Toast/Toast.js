import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { X, Lock, Megaphone, TriangleAlert, PartyPopper, CircleOff } from 'lucide-preact';
import { animate, createScope, createSpring, createDraggable } from 'animejs';

const html = htm.bind(h);

let icon = {
    'lock': Lock,
    'primary': Megaphone,
    'warning': TriangleAlert,
    'success': PartyPopper,
    'null': CircleOff,
}


export default Toast = ({ id, message, options={}, onDismiss }) => {

    const root = useRef(null);
    const scope = useRef(null);

    const dismiss = () => {
        // trigger the bounce-out animation
        scope.current.methods.bounceOut();
    }

    useEffect(() => {
        let word_count = message.split(' ').length;

        // set a default duration based on the message length
        let default_duration = 3000; // default to 3 seconds
        if(word_count >= 5){
            default_duration = 3000 + (word_count - 5) * 400; // 3 seconds + 0.4 seconds for each additional word
        }

        let duration = options.duration || default_duration;

        // set up animations
        scope.current = createScope({ root }).add( self => {

            // Created a bounce animation loop
            animate(root.current, {
                opacity: [0, 1],
                translateY: [20, 0],
                duration: 500,
                easing: 'out(2)',
                delay: 200,
            });

            // Make the logo draggable around its center
            createDraggable(root.current, {
                container: [0, 0, 0, 0],
                releaseEase: createSpring({ stiffness: 200 })
            });

            animate('.bip-toast-progress-bar', {
                width: ['0%', '90%'],
                duration: duration,
                easing: 'linear',
            });

            // set up a bounce-out animation when the toast is dismissed
            self.add('bounceOut', ()=>{
                animate(root.current, {
                    opacity: [1, 0],
                    translateY: [0, -20],
                    duration: 500,
                    easing: 'out(2)',
                    onComplete: () => {
                        // after the animation, call the onDismiss callback
                        onDismiss(id);
                    }
                });
            })
        });

        // when time's up, dismiss the toast
        const timer = setTimeout(() => {
            dismiss(id);
        }, duration);

        return () => {
            // clean up animations and timer
            scope.current.revert();
            clearTimeout(timer);
        };
    }, []);

    let Icon = null;
    if(options.icon && icon[options.icon]){
        Icon = icon[options.icon];
    }
    else if(options.variation && icon[options.variation]){
        Icon = icon[options.variation];
    }


    let variationClass = options.variation ? ` bip-toast-${options.variation}` : 'bip-toast-default';

    return html`
        <div ref=${root} class="bip-toast ${variationClass}" role="alert">
            <p class="bip-toast-icon">
                ${ Icon ? html`<${Icon} />` : null }
            </p>
            <p class="bip-toast-message">
                ${message}
            </p>
            <button class="bip-toast-dismiss" onClick=${dismiss}>
                <${X} />
            </button>

            <div class="bip-toast-progress-bar"></div>
        </div>
    `;
}