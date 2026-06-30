export default class Image {

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

    async uploadBase64Image({slug, data}){
        let resp = await this.fetch(`api/community/${slug}/image_base64`, {
            method: 'POST',
            body: JSON.stringify({
                image: data
            }),
        });
        console.dir(resp);
        return resp;
    }


}