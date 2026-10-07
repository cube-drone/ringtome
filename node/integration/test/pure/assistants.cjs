// Connecting an AI assistant (pure/assistants.js; plans/MCP.md Slice 6): the address, Claude Code's
// line for it, and whether a web assistant could reach it at all.
const assert = require('node:assert');

let assistantSetup, onlyThisComputer;
before(async () => {
    ({ assistantSetup, onlyThisComputer } = await import('../../../js/pure/assistants.js'));
});

describe('connecting an AI assistant', () => {
    it('the address is /mcp under the base, whatever slashes the base ends in', () => {
        assert.equal(
            assistantSetup('https://horses.example').address,
            'https://horses.example/mcp',
        );
        assert.equal(
            assistantSetup('https://horses.example//').address,
            'https://horses.example/mcp',
        );
    });

    it("Claude Code's line names the address", () => {
        assert.equal(
            assistantSetup('https://horses.example').claudeCode,
            'claude mcp add --transport http horse-drawing-tycoon https://horses.example/mcp',
        );
    });

    it('an address only this computer reaches says so; a public one does not', () => {
        for (const local of [
            'http://localhost:5281/mcp',
            'http://127.0.0.1:6321/mcp',
            'http://[::1]:5281/mcp',
            'http://horses.localhost/mcp',
            'not a url',
        ]) {
            assert.equal(onlyThisComputer(local), true, local);
        }
        assert.equal(onlyThisComputer('https://horses.example/mcp'), false);
        assert.equal(
            onlyThisComputer('http://192.168.1.5:5281/mcp'),
            false,
            'a LAN address is not this computer',
        );
        assert.equal(assistantSetup('http://localhost:5281').local, true);
    });
});
