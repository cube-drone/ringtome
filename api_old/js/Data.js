import makeFetchHappen from './http/fetch.js';
import Dexie from 'dexie';

import Community from './model/Community.js';
import Verify from './model/Verify.js';
import Session from './model/Session.js';
import User from './model/User.js';
import InviteCode from './model/InviteCode.js';
import Audit from './model/Audit.js';
import Message from './model/Message.js';
import Live from './model/Live.js';
import TrafficForm from './model/TrafficForm.js';
import Image from './model/Image.js';

export default class Data{
    constructor({endpoint, options = {}}){
        this.endpoint = endpoint;
        console.log("Booting Data System with endpoint", endpoint);

        this.fetch = makeFetchHappen({endpoint, options: {...options}});
        this.fetch_no404 = makeFetchHappen({endpoint, options: {...options, errorOn404: false}});

        this.local = {};
    }

    async boot(){
        // Perform any necessary initialization here

        // First, get the app-wide config
        let config = await this.config();
        console.dir("App Config", config);

        this.models = {
            'community': new Community(),
            'verify': new Verify(),
            'session': new Session(),
            'user': new User(),
            'invitecode': new InviteCode(),
            'audit': new Audit(),
            'message': new Message(),
            'live': new Live(),
            'trafficform': new TrafficForm(),
            'image': new Image(),
        }

        // Request the schema from all models
        // and merge them into a single schema object
        let schema = {};
        for(let model of Object.values(this.models)){
            if(!model.schema){
                continue;
            }
            schema = { ...model.schema(), ...schema };
        }

        console.dir(`Local Database Schema v.${config.version}`, schema);

        this.db = new Dexie('groovelet');
        this.db.version(config.version).stores(schema);

        // Pass the Dexie instance to each model
        // so they can use it to access the database
        //  (as well as all other models, in case they need that data for some reason)
        for(let model of Object.values(this.models)){
            if(!model.instantiate){
                continue;
            }
            model.instantiate({
                db: this.db,
                models: this.models,
                fetch: this.fetch,
                fetch_no404: this.fetch_no404,
                endpoint: this.endpoint
            });
        }

        // for each model, attach it to this object as a property
        //  so, for example, you can do `window.Data.community.addActiveCommunity({community_slug: 'my-community'})`
        for(let [name, model] of Object.entries(this.models)){
            this[name] = model;
            console.log(`Model ${name} attached to Data instance.`);
        }
    }

    semverToInteger(version){
        // Convert a semver string to an integer for comparison
        let parts = version.split('.').map(Number);
        return parts[0] * 10000 + parts[1] * 100 + parts[2];
    }

    async config(){
        // we save the config in this.local.config: which means we only fetch it once, when the Data system is booted
        if(this.local.config){
            return this.local.config;
        }
        else{
            console.log("getting config");
            let config = await this.fetch('api/config');
            config.version = this.semverToInteger(config.app_version);
            this.local.config = config;
            return config;
        }
    }
}