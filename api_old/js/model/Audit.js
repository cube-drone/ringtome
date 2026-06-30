export default class Audit {

    // every Model has a schema method that returns the schema for the model
    schema(){
        // Audit doesn't require any local data
        return {
        }
    }

    // instantiate is called when the Data system is booted
    instantiate({db, models, fetch, fetch_no404}){
        this.db = db;
        this.models = models;
        this.fetch = fetch;
        this.fetch_no404 = fetch_no404;
    }

    async getAudits({slug, user_id, system, action, triggered_by, ip, forwarded_for, fingerprint, n=100, offset=0}){

        const params = new URLSearchParams({
        ...(user_id && { user_id }),
        ...(system && { system }),
        ...(action && { action }),
        ...(triggered_by && { triggered_by }),
        ...(ip && { ip }),
        ...(forwarded_for && { forwarded_for }),
        ...(fingerprint && { fingerprint }),
        n,
        offset
        });

        return this.fetch(`api/community/${slug}/audit?${params.toString()}`);
    }

}