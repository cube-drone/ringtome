

export default class Verify {

    // every Model has a schema method that returns the schema for the model
    schema(){
        // Verify doesn't require any local data
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

    async sendSmsVerificationCode({slug}){
        //.route("/api/community/{:slug}/auth/verify/sms", post(modules::user::routes::send_sms_verification))

        return this.fetch(`api/community/${slug}/auth/verify/sms`, {
            method: 'POST'
        });
    }

    async verifySmsVerificationCode({slug, user_id, code}){
        //.route("/api/community/{:slug}/auth/verify/sms/complete", post(modules::user::routes::complete_sms_verification))

        return this.fetch(`api/community/${slug}/auth/verify/sms/complete`, {
            method: 'POST',
            body: JSON.stringify({
                user_id,
                code
            })
        });
    }

    async sendEmailVerificationCode({slug}){
        //.route("/api/community/{:slug}/auth/verify/email", post(modules::user::routes::send_email_verification))

        return this.fetch(`api/community/${slug}/auth/verify/email`, {
            method: 'POST'
        });
    }

    async verifyEmailVerificationCode({slug, user_id, code}){
        //.route("/api/community/{:slug}/auth/verify/sms/complete", post(modules::user::routes::complete_email_verification))

        return this.fetch(`api/community/${slug}/auth/verify/email/complete`, {
            method: 'POST',
            body: JSON.stringify({
                user_id,
                code
            })
        });
    }

}