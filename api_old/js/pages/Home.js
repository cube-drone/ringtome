import { h, render } from 'preact';
import { useEffect } from 'preact/hooks'
import { useLocation } from 'preact-iso';
import htm from 'htm';
import { useLiveQuery } from 'dexie-react-hooks';
import { HousePlus, LogIn, MessageCircleQuestionMark } from 'lucide-preact';

const html = htm.bind(h);

import BasicPageLayout from './BasicPageLayout.js';
import Button from '../bips/Button.js';
import Flexstack from '../bips/Flexstack.js';
import ButtonFrame from '../bips/ButtonFrame.js';

const Home = () => {

    let { url, path, query, route } = useLocation();

    useEffect(() => {
        document.title = "Home";
    }, []);

    const activeCommunities = useLiveQuery(async () => {
        try{
            let communities = await window.Data.community.getActiveCommunities({n: 5});
            return communities;
        } catch(err){
            console.error("Error fetching active communities:", err);
            return [];
        }
    }, []);

    let create = () => {
        route("/home/create");
    };
    let find = () => {
        route("/home/find");
    };
    let about = () => {
        route("/home/about");
    };


    return html`
    <${BasicPageLayout} id="home" title="Home" fullyTransparent>
        <div>
            <div class="home-cloud home-cloud-1">
                <div>
                    Already part of a Community? Find it here to log-in!
                </div>
                <div>
                    <${Button} label="Find" onClick=${find}>Find Community</${Button}>
                </div>
            </div>
            <div class="home-cloud home-cloud-2">
                <div>
                    A Community is a group of users working together. Create one to get started!
                </div>
                <div>
                    <${Button} label="Create" onClick=${create}>Create Community</${Button}>
                </div>
            </div>

            <div class="home-cloud home-cloud-3">
                <div>
                    What is groovelet.com?
                </div>
                <div>
                    <${Button} label="About" onClick=${about}>??</${Button}>
                </div>
            </div>
        </div>
    <//>
    `;
}

export default Home;