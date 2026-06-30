export default class InviteCode {

    // every Model has a schema method that returns the schema for the model
    schema(){
        // User doesn't require any local data
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

    async getInviteCodes({slug}){
        return this.fetch(`api/community/${slug}/invite`);
    }

    async createInviteCode({slug, use_type}){
        console.warn("hi");

        if(use_type !== "once" && use_type !== "unlimited"){
            throw new Error("Invalid use_type");
        }
        let resp = await this.fetch(`api/community/${slug}/invite`, {
            method: 'POST',
            body: JSON.stringify({
                use_type
            })
        });
        return {
            invite_code: resp.invite_code,
            created_at: new Date(),
            use_type
        }
    }

    async deleteInviteCode({slug, code}){
        return this.fetch(`api/community/${slug}/invite/${code}`, {
            method: 'DELETE'
        });
    }

}