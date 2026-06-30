/*
    fitch is just a fetch wrapper that prepends the URL with the localhost:3000 prefix.
*/
const makeFetchCookie = require('fetch-cookie').default;
const { CookieJar } = require('tough-cookie');
const { host } = require('./localhost.cjs');

function makeFetchHappen(){
    const jar = new CookieJar();
    const fitch = makeFetchCookie(fetch, jar);

    let fn = (...args) => {
        args[0] = `http://${host}/${args[0]}`;

        // If we're sending a body, we need to set the Content-Type header to application/json
        if(args[1] && args[1].body && !args[1].file){
            if(!args[1].headers){
                args[1].headers = {};
            }
            args[1].headers['Content-Type'] = 'application/json';
        }
        if(args[1] && args[1].file){
            delete args[1].file;
        }

        return fitch(...args);
    }
    fn.jar = jar;
    fn.cookies = async () => {
        return new Promise((resolve, reject) => {
            jar.store.getAllCookies((err, cookies) => {
                if(err){
                    reject(err);
                } else {
                    resolve(cookies);
                }
            });
        });
    }

    return fn;
}

module.exports = makeFetchHappen;