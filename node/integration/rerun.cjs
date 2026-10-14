/*
    After a red run: each file that failed, run again five times, whole, and how often each failed
    test failed again (Curtis, 2026-10-13). Never a pass - the recipe keeps the first run's verdict -
    only evidence: 5 of 5 is very likely a real failure, fewer is a flake, and a flake is worth
    chasing too, for the time it costs.

    Whole files, not the one test: a claim run alone, without the claims before it that set it up,
    fails for that reason alone - which is exactly the false evidence this exists to avoid.

    node rerun.cjs <failures file>   (the rig's nodes still up, its environment set: the recipe calls it)
*/
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RERUNS = 5;
const failedFile = process.argv[2];
const read = (file) =>
    fs.existsSync(file)
        ? fs
              .readFileSync(file, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
        : [];

const failed = read(failedFile);
if (!failed.length) {
    console.log(
        '\nrerun: the run failed, but no test was named (a hook failed?) - nothing to rerun.',
    );
    process.exit(0);
}
const byFile = new Map();
for (const f of failed) {
    if (!byFile.has(f.file)) byFile.set(f.file, new Set());
    byFile.get(f.file).add(f.title);
}
// Failures across this many files is a rig that fell over (a node crashed: 85 claims in dozens of
// files, 2026-10-13), not something five reruns a file can tell apart - and it would take hours.
const MAX_FILES = 6;
if (byFile.size > MAX_FILES) {
    console.log(
        `\nrerun: ${failed.length} failures across ${byFile.size} files - more like the rig falling over ` +
            '(look for a node that died in /tmp/ringtome-integration*.log) than flakes; not rerun.',
    );
    process.exit(0);
}

const tally = new Map(failed.map((f) => [f.title, 0]));
for (const [file, titles] of byFile) {
    for (let i = 1; i <= RERUNS; i++) {
        const into = `${failedFile}.rerun`;
        fs.rmSync(into, { force: true });
        // --no-config: the config's spec glob would add every file back.
        spawnSync(
            'npx',
            [
                'mocha',
                '--no-config',
                '--require',
                './roothooks.cjs',
                '--exit',
                '--timeout',
                String(require('./.mocharc.cjs').timeout),
                file,
            ],
            { stdio: 'ignore', env: { ...process.env, RINGTOME_FAILED_FILE: into } },
        );
        const again = new Set(read(into).map((f) => f.title));
        for (const t of titles) if (again.has(t)) tally.set(t, tally.get(t) + 1);
        process.stdout.write(`rerun: ${path.basename(file)} ${i}/${RERUNS}\r`);
    }
}

const lines = [...tally].map(
    ([title, n]) =>
        `${n === RERUNS ? 'LIKELY REAL' : n === 0 ? 'FLAKE      ' : 'UNSTABLE   '}  failed ${n} of ${RERUNS} reruns  ${title}`,
);
const report = `\nWhat failed, run again (each file whole, ${RERUNS} times):\n${lines.join('\n')}\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Failed tests, rerun ${RERUNS} times\n\n| verdict | failed again | test |\n|---|---|---|\n` +
            [...tally]
                .map(
                    ([t, n]) =>
                        `| ${n === RERUNS ? 'likely real' : n === 0 ? 'flake' : 'unstable'} | ${n}/${RERUNS} | ${t.replace(/\|/g, '\\|')} |`,
                )
                .join('\n') +
            '\n',
    );
}
