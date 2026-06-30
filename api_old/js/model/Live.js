export default class Live {

    // every Model has a schema method that returns the schema for the model
    schema(){
        // Live doesn't require any local data
        return {
        }
    }

    // instantiate is called when the Data system is booted
    instantiate({db, models, fetch, fetch_no404, endpoint}){
        this.db = db;
        this.models = models;
        this.fetch = fetch;
        this.fetch_no404 = fetch_no404;
        this.endpoint = endpoint;

        // What do we do with events?
        this.connection_listeners = {};

        // WebSocket connection for live updates
        this.ws = null;

        // Backup connection using polling
        this.connection_id = null;
        this.connection_loop = null;
    }

    async createConnection({slug}){
        try{
            let ws_endpoint = this.endpoint.replace('http://', 'ws://').replace('https://', 'wss://');
            this.ws = new WebSocket(`${ws_endpoint}/api/community/${slug}/live_ws`);

            this.ws.addEventListener('open', (event) => {
                console.log("WebSocket connection opened:", event);
            });

            this.ws.addEventListener('message', async (event) => {
                let data = JSON.parse(event.data);
                console.dir("Received live event", data);
                await this.routeEvent(data);
            });

            this.ws.addEventListener('close', async (event) => {
                console.log("WebSocket connection closed:", event);
                await this.closeConnection({slug});
            });
        }
        catch(err){
            console.error("Error in websocket connection:", err);
            await this.closeConnection({slug});
        }
    }

    async closeConnection({slug}){
        if(this.ws){
            this.ws.close();
            this.ws = null;
        }
        await this.createBackupConnection({slug});
    }

    async routeEvent(event){
        //if event is string:
        let event_type = event;
        let event_value = null;
        if(typeof event !== 'string'){
            event_type = Object.keys(event)[0];
            event_value = event[event_type];
        }
        let listeners = this.connection_listeners[event_type] || [];
        for(let callback of listeners){
            try{
                await callback(event_value);
            }
            catch(e){
                console.error("Error in live event callback:", e);
            }
        }
    }

    async createBackupConnection({slug}){
        let connection_id = await this.fetch(`api/community/${slug}/live`, {
            method: 'POST',
        });
        console.dir("Created live connection", connection_id);
        this.connection_id = connection_id;

        // replace this connection loop if it exists
        //  (replace this whole thing with a websocket later?)
        if(this.connection_loop){
            clearInterval(this.connection_loop);
            this.connection_loop = null;
        }

        let failureCount = 0;

        this.connection_loop = setInterval(async () => {
            try{
                let events = await this.fetch_no404(`api/community/${slug}/live/${connection_id}/events`);
                if(events == null){
                    throw new Error("Connection ID not found");
                }
                if(events.length === 0){
                    return;
                }
                console.dir("Fetched live events", connection_id);
                console.dir(events);
                for(let event of events){
                    await this.routeEvent(event);
                }
            }
            catch(err){
                console.error("Error fetching live events:", err);
                failureCount++;
                if(failureCount > 5){
                    clearInterval(this.connection_loop);
                    this.connection_loop = null;
                }
            }
        }, 5000);

        return connection_id;
    }

    on(eventType, callback){
        if(!this.connection_listeners[eventType]){
            this.connection_listeners[eventType] = [];
        }
        this.connection_listeners[eventType].push(callback);
    }

}