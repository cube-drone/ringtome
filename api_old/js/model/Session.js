export default class Session {

    // every Model has a schema method that returns the schema for the model
    schema(){
        // Session doesn't require any local data
        return {
        }
    }

    // instantiate is called when the Data system is booted
    instantiate({db, models, fetch, fetch_no404}){
        this.db = db;
        this.models = models;
        this.fetch = fetch;
        this.fetch_no404 = fetch_no404;
        this.local = {};
    }

    /* If we already HAVE a session, this will just return it. */
    async getSession({slug, reload, touch}){
        if(!reload && this.local[slug] && this.local[slug].session){
            if(this.local[slug].session instanceof Error){
                // if the session is an error, throw it (we're not logged in)
                throw this.local[slug].session;
            }
            return this.local[slug].session;
        }

        let touchQuery = '';
        if(touch){
            touchQuery = '?touch=true';
        }

        let resp;
        try{
            resp = await this.fetch(`api/community/${slug}/auth${touchQuery}`);
        }
        catch(e){
            if(!e.message){
                throw e;
            }
            let message = e.message.toLowerCase();
            if(message.includes("no session") || message.includes("not valid")){
                // we can cache "not logged in" errors
                this.local[slug] = this.local[slug] || {};
                this.local[slug].session = e;
            }
            throw e;
        }

        // set dat cache
        this.local[slug] = this.local[slug] || {};
        this.local[slug].session = resp;

        return resp;
    }

    async logout({slug}){
        delete this.local[slug];
        return this.fetch(`api/community/${slug}/logout`);
    }

    async login({slug, email, phone_number, password}){
        delete this.local[slug];
        if(!password){
            // do something different
            throw new Error("Login requires a password");
        }

        return this.fetch_no404(`api/community/${slug}/login`, {
            method: 'POST',
            body: JSON.stringify({
                email,
                phone_number,
                password
            })
        });
    }

    async loginToken({slug, email, phone_number}){
        let query = {};
        if(email){
            query.email = email;
        }
        if(phone_number){
            query.phone_number = phone_number;
        }

        return this.fetch_no404(`api/community/${slug}/login/token`, {
            method: 'POST',
            body: JSON.stringify(query)
        });
    }

    async loginTokenComplete({slug, token, user_id}){
        delete this.local[slug];
        return this.fetch_no404(`api/community/${slug}/login/token/complete?code=${token}&user_id=${user_id}`, {
            method: 'POST',
            body: JSON.stringify({})
        });
    }

}