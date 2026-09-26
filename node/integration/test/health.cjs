const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch } = require("./fetch.cjs");

describe("health", function () {
    it("returns 200 with a JSON body reporting status ok", async function () {
        const fetch = makeFetch();
        const resp = await fetch("health");

        assert.equal(resp.status, 200);
        assert.match(resp.headers.get("content-type") || "", /application\/json/);

        const body = await resp.json();
        assert.equal(body.status, "ok");
        assert.ok(body.version, "expected a version string");
    });
});

// The app's icon (branding/README.md), on the tab and on a phone's home screen: served from the root,
// where browsers and iOS ask for it unprompted, and named in the page so nobody has to guess.
describe("the icon", function () {
    it("serves the favicon and the home-screen icon, and the page links both", async function () {
        const fetch = makeFetch();
        const ico = await fetch("favicon.ico");
        assert.equal(ico.status, 200);
        assert.equal(ico.headers.get("content-type"), "image/x-icon");
        const icoBytes = Buffer.from(await ico.arrayBuffer());
        assert.deepEqual([...icoBytes.subarray(0, 4)], [0, 0, 1, 0], "an .ico file");
        assert.equal(icoBytes.readUInt16LE(4), 3, "with three sizes in it");

        const touch = await fetch("apple-touch-icon.png");
        assert.equal(touch.status, 200);
        assert.equal(touch.headers.get("content-type"), "image/png");
        const png = Buffer.from(await touch.arrayBuffer());
        assert.equal(png.subarray(1, 4).toString(), "PNG");
        assert.equal(png.readUInt32BE(16), 180, "180 px, the size iOS asks for");

        const page = await (await fetch("home")).text();
        assert.match(page, /<link rel="icon" href="\/favicon\.ico"/);
        assert.match(page, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
    });
});
