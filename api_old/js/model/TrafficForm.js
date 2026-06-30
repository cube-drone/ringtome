export default class TrafficForm {

    // every Model has a schema method that returns the schema for the model (if they save local data)
    schema(){
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

    async getForms({slug}){
        return this.fetch(`api/community/${slug}/traffic-control-form`);
    }

    async getForm({slug, formId}){
        return this.fetch_no404(`api/community/${slug}/traffic-control-form/${formId}`);
    }

    async createOrUpdateForm({slug, form}){
        return this.fetch(`api/community/${slug}/traffic-control-form`, {
            method: 'POST',
            body: JSON.stringify(form),
        });
    }

    async deleteForm({slug, formId}){
        return this.fetch(`api/community/${slug}/traffic-control-form/${formId}`, {
            method: 'DELETE',
        });
    }

    async submitForm({slug, formId}){
        return this.fetch(`api/community/${slug}/traffic-control-form/${formId}/state`, {
            method: 'POST',
            body: JSON.stringify({state: 'submitted'}),
        });
    }

    async approveForm({slug, formId}){
        return this.fetch(`api/community/${slug}/traffic-control-form/${formId}/state`, {
            method: 'POST',
            body: JSON.stringify({state: 'approved'}),
        });
    }

}