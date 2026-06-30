import { h, Component, render, createRef } from 'preact';
import htm from 'htm';

import BasicPageLayout from '../pages/BasicPageLayout.js';
import Collapsibro from './Collapsibro.js';
import Button from './Button.js';
import ButtonFrame from './ButtonFrame.js';
import Alert from './Alert.js';
import Flexstack from './Flexstack.js';

const html = htm.bind(h);


const BipSamplePage = () => {
    return html`
    <${BasicPageLayout} title="Bip Sample Page">

        <h2>Collapsibro</h2>
        <${Collapsibro} title="Collapsibro Title">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro} variant="primary" title="Primary Collapsibro">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro} variant="warning" title="Warning Collapsibro">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro} variant="success" title="Success Collapsibro">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro} variant="null" title="Null Collapsibro">
            <p>This is the content of the Collapsibro.</p>
            <p>You can put any content you want here, including other components.</p>
            <p>Look upon my works, ye mighty, and despair</p>
        <//>

        <${Collapsibro} title="Matroyshka Collapsibro 1">
            <${Collapsibro} title="Matroyshka Collapsibro 2">
                <${Collapsibro} title="Matroyshka Collapsibro 3">
                    <${Collapsibro} title="Matroyshka Collapsibro 4">
                        Surprise! You found the innermost Collapsibro!
                    <//>
                    <${Collapsibro} title="Matroyshka Collapsibro 5">
                        Surprise! You found the innermost Collapsibro!
                    <//>
                <//>
            <//>
        <//>

        <h2>Buttons</h2>

        <${Button} title="CLICK MEEEEEE" onClick=${() => alert('Button Clicked!')}>
            Button Text
        <//>
        <${Button} title="yay" variant="primary" onClick=${() => alert('Button Clicked!')}>
            Button Text
        <//>
        <${Button} title="angery" variant="warning" onClick=${() => alert('Button Clicked!')}>
            Button Text
        <//>
        <${Button} title="u can't touch this" variant="primary" disabled onClick=${() => alert('Button Clicked!')}>
            Button Text
        <//>
        <${Button} title="yay" variant="success" disabled>
            Button Text
        <//>
        <${Button} title="boo" variant="null" disabled>
            Button Text
        <//>
        <${Button} loading title="CLICK MEEEEEE" onClick=${() => alert('Button Clicked!')}>
            Button Text
        <//>
        <${Button} loading title="yay" variant="primary" onClick=${() => alert('Button Clicked!')}>
            Button Text
        <//>
        <${Button} loading title="angery" variant="warning" onClick=${() => alert('Button Clicked!')}>
            Button Text
        <//>
        <${Button} loading title="u can't touch this" variant="primary" disabled onClick=${() => alert('Button Clicked!')}>
            Button Text
        <//>
        <${Button} loading title="yay" variant="success" disabled>
            Button Text
        <//>
        <${Button} loading title="boo" variant="null" disabled>
            Button Text
        <//>


        <h2>Button Frames</h2>
        <${Flexstack}>
            <${ButtonFrame} title="CLICK MEEEEEE" label="Click Me" onClick=${() => alert('Button Frame Clicked!')}>
                <span>Button Frame Text</span>
            <//>
            <${ButtonFrame} title="CLICK MEEEEEE" label="Click Me" variant="warning" onClick=${() => alert('Button Frame Clicked!')}>
                <span>Button Frame Text</span>
            <//>
        <//>
        <${Flexstack}>
            <${ButtonFrame} title="CLICK MEEEEEE" label="Click Me" variant="success" onClick=${() => alert('Button Frame Clicked!')}>
                <span>Button Frame Text</span>
            <//>
            <${ButtonFrame} title="CLICK MEEEEEE" label="Click Me" variant="null" onClick=${() => alert('Button Frame Clicked!')}>
                <span>Button Frame Text</span>
            <//>
        <//>

        <h2>Alerts</h2>
        <${Alert} message="hi"/>
        <${Alert} title="Oh no!" message="This is an error alert!" variant="error"/>
        <${Alert} title="Warning!" message="This is a warning alert!" variant="warning"/>
        <${Alert} title="Info" message="This is an info alert!" variant="info"/>
        <${Alert} title="Success" message="This is a success alert!" variant="success"/>
        <${Alert} title="Null" message="This is a null alert!" variant="null"/>
    <//>`;
}



export default BipSamplePage;