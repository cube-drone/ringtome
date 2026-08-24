// Mocha's per-test ceiling, environment-scaled - the other half of helpers.cjs::settleWith
// (2026-08-24). The suite's budgets were all sized on a dev machine; CI runners are 2-4x
// slower with fat tails, and a FIXED 5000ms ceiling meant any test doing ~2s of local work
// could trip remotely while every local run stayed green. One knob scales every budget:
// RINGTOME_TEST_SETTLE_SCALE multiplies the settle loops and this ceiling together
// (ci.yml sets it; local runs default to 1 and behave exactly as before).
const scale = Math.max(1, parseInt(process.env.RINGTOME_TEST_SETTLE_SCALE || "1", 10) || 1);
module.exports = {
    spec: "test/**/*.cjs",
    require: "./roothooks.cjs",
    timeout: 5000 * scale,
};
