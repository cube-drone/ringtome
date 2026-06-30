/*
    so, the default fetch is nice and simple, but there are a few quick utility things we want to do:
    - we want to prepend the endpoint to the URL so we don't have to do that every time
        - e.g. if the endpoint is 'https://api.example.com' and we call fetch('users'), it should fetch 'https://api.example.com/users'
    - if we send a body, we need to set the Content-Type header to application/json
    - if we get a 422, we want to throw an error with the response text
    - if we get a 404, we want to return null instead of throwing an error,
        - if we get a 404 and options.errorOn404 is true, we want to throw an error
    - if we get anything other than a 200, we want to throw an error with the response message

    - if we get a 200, we want to return the JSON response
*/
export default function makeFetchHappen({endpoint, options = {}} = {}) {
    const fitch = async (...args) => {
        let originalTarget = args[0];
        let slug = false;
        if(originalTarget.startsWith('api/community/')){
            // if the target starts with /api/community/:slug/blahblahblah, we need to extract the slug from it
            let parts = originalTarget.split('/');
            if(parts.length > 3){
                slug = parts[2];
            }
        }
        args[0] = `${endpoint}/${originalTarget}`;

        // If we're sending a body, we need to set the Content-Type header to application/json
        if(args[1] && args[1].body){
            if(!args[1].headers){
                args[1].headers = {};
            }
            args[1].headers['Content-Type'] = 'application/json';
        }

        // we might want to delay the request for testing purposes: if everything in the application takes Nms to respond,
        //  it'll be easier to see loading effects and such
        if(options.network_simulation){
            let possibleDelays = [10, 50, 50, 50, 50, 50, 100, 200, 500, 1000];
            let delay = possibleDelays[Math.floor(Math.random() * possibleDelays.length)];
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        let resp = await fetch(...args);
        if(resp.status == 422){
            let text = await resp.text();
            console.error(text);
            throw new Error(text);
        }
        if(resp.status == 401){
            // we got a 401, which means we need to log the user out
            console.error('Unauthorized request, logging out user');

            await fetch(`${endpoint}/api/community/${slug}/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            throw new Error('Login session expired, please try again');
        }
        if(resp.status == 404 && !options.errorOn404){
            return null;
        }
        let json = await resp.json();
        if(resp.status != 200){
            console.error(json.message);
            throw new Error(json.message);
        }
        return json;
    }
    return fitch;
}