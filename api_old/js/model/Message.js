export default class Message {

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

    async getMessages({slug, n=100, offset=0}){
        return this.fetch(`api/community/${slug}/messages?n=${n}&offset=${offset}`);
    }

    async getMessagesAfter({slug, timestamp_micros, n=100, offset=0}){
        return this.fetch(`api/community/${slug}/messages/after/${timestamp_micros}?n=${n}&offset=${offset}`);
    }

    async sendMessage({slug, userId, content}){
        return this.fetch(`api/community/${slug}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                target_user_id: userId,
                message: content
            }),
        });
    }

    async markAsSeen({slug, messageId}){
        return this.fetch_no404(`api/community/${slug}/messages/${messageId}/seen`, {
            method: 'POST',
        });
    }

    async deleteMessage({slug, messageId}){
        return this.fetch(`api/community/${slug}/messages/${messageId}`, {
            method: 'DELETE',
        });
    }

    async getUnseenMessageCount({slug}){
        return this.fetch(`api/community/${slug}/messages/count`);
    }

}