

export default class Community {

    // every Model has a schema method that returns the schema for the model
    schema(){
        return {
            active_communities: '++community_slug,last_access',
            community_names: '++community_slug,community_name',
        }
    }

    // instantiate is called when the Data system is booted
    instantiate({db, models, fetch, fetch_no404}){
        this.db = db;
        this.models = models;
        this.fetch = fetch;
        this.fetch_no404 = fetch_no404;
    }

    // -- ACTIVE COMMUNITIES --
    // These are communities that the user is currently logged into or has recently accessed
    // (users are likely to return to the same communities frequently, so making them search every time is annoying)

    async addActiveCommunity({community_slug}){
        console.dir(`Adding active community: ${community_slug}`);
        // Add a community to the active communities list
        // if it doesn't already exist
        // (put is an upsert)
        await this.db.active_communities.put({ community_slug, last_access: new Date() });
    }

    async removeActiveCommunity({community_slug}){
        // Remove a community from the active communities list
        await this.db.active_communities.delete(community_slug);
    }

    async getActiveCommunities({n}){
        // Get the list of active communities, with the most recently accessed first
        return await this.db.active_communities.orderBy('last_access').reverse().limit(n).toArray();
    }


    // -- CREATING & LISTING COMMUNITIES --

    async createCommunity({community_name, name, email, phone_number, password, tos}){
        return this.fetch('api/community', {
            method: 'POST',
            body: JSON.stringify({community_name, name, email, phone_number, password, tos})
        });
    }

    async listCommunities({prefix, n=5, offset=0}){
        console.warn("Listing communities with prefix", prefix, "n", n, "offset", offset);
        let communities = await this.fetch(`api/community?prefix=${prefix}&n=${n}&offset=${offset}`);

        // if we got a list of communities, add them to the local database
        if(communities && communities.length > 0){
            for(let community of communities){
                try{
                    await this.db.community_names.put({
                        community_slug: community.community_slug,
                        community_name: community.community_name,
                    });
                }
                catch(err){
                    console.error("Error adding community to local database", err);
                }
            }
        }

        return communities;
    }

    async getCommunity({slug}){
        // check if we already have this community in the local database
        let community = await this.db.community_names.get(slug);
        if(community){
            return community;
        }
        community = await this.fetch(`api/community/${slug}`);
        // if we got a community, add it to the local database
        if(community){
            await this.db.community_names.add({
                community_slug: community.community_slug,
                community_name: community.community_name,
            });
        }

        return community;
    }

    async getCommunitySettings({slug}){
        return this.fetch(`api/community/${slug}/settings`);
    }

    async setCommunitySettings({slug, settings}){
        return this.fetch(`api/community/${slug}/settings`, {
            method: 'POST',
            body: JSON.stringify(settings)
        });
    }

}