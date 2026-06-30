export default class User {

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

        // user_cache is used to cache user data within the current invocation of the app
        // (it will be reset on every page load)
        this.user_cache = {}
        this.user_promise_cache = {};
        this.user_cache_by_slug = {};
        this.user_promise_cache_by_slug = {};
    }

    async createUser({slug, user, invite_code}){
        let {name, email, phone_number, password, tos} = user;
        return this.fetch(`api/community/${slug}/invite/${invite_code}`, {
            method: 'POST',
            body: JSON.stringify({name, email, phone_number, password, tos})
        });
    }

    async listUsers({slug}){
        return this.fetch(`api/community/${slug}/users`);
    }

    clearUserCache(){
        this.user_cache = {};
        this.user_promise_cache = {};
        this.user_cache_by_slug = {};
    }

    // this cache pattern allows us not just to cache the user data after it is fetched,
    //  but also to have multiple simultaneous requests for the same user all use the same network call
    //  rather than triggering multiple network calls for the same user
    // (this is useful for when multiple components on the page need the same user data)
    async getUser({slug, userId}){
        if (this.user_cache[userId]) {
            return this.user_cache[userId];
        }
        if (this.user_promise_cache[userId]) {
            return this.user_promise_cache[userId];
        }

        let user_promise = this.fetch(`api/community/${slug}/user/${userId}`);
        this.user_promise_cache[userId] = user_promise;
        let user = await user_promise;
        delete this.user_promise_cache[userId];

        if(user){
            this.user_cache[userId] = user;
            this.user_cache_by_slug[user.slug] = user;
            return user;
        }
    }

    async getUserBySlug({slug, userSlug}){
        if(this.user_cache_by_slug[userSlug]) {
            return this.user_cache_by_slug[userSlug];
        }
        if(this.user_promise_cache_by_slug[userSlug]) {
            return this.user_promise_cache_by_slug[userSlug];
        }
        let user_promise = this.fetch(`api/community/${slug}/slug/${userSlug}`);
        this.user_promise_cache_by_slug[userSlug] = user_promise;
        let user = await user_promise;
        delete this.user_promise_cache_by_slug[userSlug];
        if(user){
            this.user_cache[user.id] = user;
            this.user_cache_by_slug[userSlug] = user;
            return user;
        }
    }

    async changeName({slug, name}){
        // POST /api/community/{:slug}/auth/change/name
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/auth/change/name`, {
            method: 'POST',
            body: JSON.stringify(name)
        });
    }

    async changePassword({slug, password}){
        // POST /api/community/{:slug}/auth/change/password
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/auth/change/password`, {
            method: 'POST',
            body: JSON.stringify(password)
        });
    }

    async changeEmail({slug, email}){
        // POST /api/community/{:slug}/auth/change/email
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/auth/change/email`, {
            method: 'POST',
            body: JSON.stringify(email)
        });
    }

    async changePhone({slug, phone_number}){
        // POST /api/community/{:slug}/auth/change/phone
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/auth/change/phone`, {
            method: 'POST',
            body: JSON.stringify(phone_number)
        });
    }

    async lockUser({slug, user_id}){
        // this is an admin-only action
        // POST /api/community/{:slug}/user/{:userId}/lock
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/user/${user_id}/lock`, {
            method: 'POST'
        });
    }

    async unlockUser({slug, user_id}){
        // this is an admin-only action
        // POST /api/community/{:slug}/user/{:userId}/unlock
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/user/${user_id}/unlock`, {
            method: 'POST'
        });
    }

    async deleteUser({slug, user_id}){
        // this is an admin-only action
        // DELETE /api/community/{:slug}/user/{:userId}
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/user/${user_id}`, {
            method: 'DELETE'
        });
    }

    async adminUser({slug, user_id}){
        // this is an admin-only action
        // POST /api/community/{:slug}/user/{:userId}/admin
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/user/${user_id}/admin`, {
            method: 'POST'
        });
    }

    async unadminUser({slug, user_id}){
        // this is an admin-only action
        // POST /api/community/{:slug}/user/{:userId}/unadmin
        this.clearUserCache();
        return this.fetch(`api/community/${slug}/user/${user_id}/unadmin`, {
            method: 'POST'
        });
    }
}