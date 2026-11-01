// Edge scrolling while dragging (pure/edgescroll.js): how fast a list scrolls under a drag held
// near its edge.
const assert = require('node:assert');

let edgeSpeed, EDGE_ZONE, EDGE_TOP_SPEED;
before(async () => {
    ({ edgeSpeed, EDGE_ZONE, EDGE_TOP_SPEED } = await import('../../../js/pure/edgescroll.js'));
});

describe('edge scrolling', () => {
    it('is still in the middle, and scrolls up near the top and down near the bottom', () => {
        assert.equal(edgeSpeed(500, 100, 900), 0);
        assert.ok(edgeSpeed(110, 100, 900) < 0, 'near the top: up');
        assert.ok(edgeSpeed(890, 100, 900) > 0, 'near the bottom: down');
    });

    it('is faster nearer the edge, full speed at it and just past it, and stops well past it', () => {
        const slow = edgeSpeed(100 + EDGE_ZONE - 2, 100, 900);
        const fast = edgeSpeed(102, 100, 900);
        assert.ok(Math.abs(fast) > Math.abs(slow), `${fast} vs ${slow}`);
        assert.equal(edgeSpeed(100, 100, 900), -EDGE_TOP_SPEED);
        assert.equal(edgeSpeed(80, 100, 900), -EDGE_TOP_SPEED, 'over the header above: still up');
        assert.equal(edgeSpeed(910, 100, 900), EDGE_TOP_SPEED);
        assert.equal(edgeSpeed(100 - EDGE_ZONE - 1, 100, 900), 0, 'far above: not this list');
    });

    it('shrinks the zones for a short list, so its middle stays still', () => {
        assert.equal(edgeSpeed(150, 100, 200), 0);
        assert.ok(edgeSpeed(105, 100, 200) < 0);
        assert.equal(edgeSpeed(150, 100, 100), 0, 'no height: nothing');
    });
});
