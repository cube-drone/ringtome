// run.js — automated headless-Chromium end-to-end test.
//
// Serves the library over loopback (secure context), drives a real Chromium
// with puppeteer-core, generates a test video in-browser, runs BOTH ingest
// lanes, re-decodes each output in the same browser, writes the output blobs to
// test/out/, and asserts. Exits non-zero on any failure. Wired as `npm test`.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startServer } from './static-server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');
const CHROME = '/snap/bin/chromium';

const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name} ${detail}`);
    failures.push(name);
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const { server, base } = await startServer();
  console.log(`static server: ${base}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Let the test video/lane playback autostart without a user gesture.
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    const page = await browser.newPage();
    page.on('console', (msg) => console.log(`    [browser] ${msg.text()}`));
    page.on('pageerror', (err) => console.error(`    [pageerror] ${err.message}`));

    await page.goto(`${base}/test/page.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 15000 });

    console.log('running full in-browser test (this records at playback speed)...');
    const result = await page.evaluate(() => window.__runFullTest());

    // ---- Assertions ----
    check('secure context', result.secureContext === true);

    const av1 = result.lanes.av1;
    const fr = result.lanes.frames;

    // av1 lane
    check('av1 lane label', av1.meta.lane === 'av1');
    check('av1 within 320px', av1.meta.width <= 320 && av1.meta.height <= 320,
      `${av1.meta.width}x${av1.meta.height}`);
    check('av1 webm has bytes', av1.meta.videoBytes > 0, `${av1.meta.videoBytes}`);
    check('av1 re-decoded (readyState>=2)', av1.verify.readyState >= 2,
      `readyState=${av1.verify.readyState}`);
    check('av1 re-decode dims <=320',
      av1.verify.width <= 320 && av1.verify.height <= 320,
      `${av1.verify.width}x${av1.verify.height}`);
    check('av1 decoded a non-blank frame', av1.verify.nonBlackPixels > 0,
      `nonBlack=${av1.verify.nonBlackPixels}`);

    // frames lane
    check('frames lane label', fr.meta.lane === 'frames');
    check('apng within 320px', fr.meta.width <= 320 && fr.meta.height <= 320,
      `${fr.meta.width}x${fr.meta.height}`);
    check('apng has bytes', fr.meta.apngBytes > 0, `${fr.meta.apngBytes}`);
    check('apng frameCount > 1', fr.apngVerify.frameCount > 1,
      `frameCount=${fr.apngVerify.frameCount}`);
    check('apng re-decode dims <=320',
      fr.apngVerify.width <= 320 && fr.apngVerify.height <= 320,
      `${fr.apngVerify.width}x${fr.apngVerify.height}`);
    check('opus present', fr.meta.opusBytes > 0, `${fr.meta.opusBytes}`);
    check('opus decodeAudioData round-trip', fr.opusVerify.ok === true,
      JSON.stringify(fr.opusVerify));
    check('opus duration > 0', (fr.opusVerify.durationSec || 0) > 0,
      `${fr.opusVerify.durationSec}`);

    // ---- Write outputs to disk for Rust cross-checking ----
    const outAv1 = path.join(OUT_DIR, 'av1.webm');
    const outApng = path.join(OUT_DIR, 'frames.apng');
    const outOpus = path.join(OUT_DIR, 'frames.opus');

    await writeFile(outAv1, Buffer.from(av1.videoB64, 'base64'));
    await writeFile(outApng, Buffer.from(fr.apngB64, 'base64'));
    if (fr.opusB64) await writeFile(outOpus, Buffer.from(fr.opusB64, 'base64'));

    check('av1.webm written', true);
    check('frames.apng written', true);
    check('frames.opus written', !!fr.opusB64);

    console.log('\n--- summary ---');
    console.log(`test video (VP9 source): ${result.testVideoBytes} bytes`);
    console.log(
      `av1 lane:    ${av1.meta.videoBytes} bytes, ${av1.meta.width}x${av1.meta.height}, ` +
        `${av1.meta.frameCount} frames @ ~${av1.meta.fps}fps, audioMuxed=${av1.meta.hasAudio}`
    );
    console.log(
      `frames lane: apng ${fr.meta.apngBytes} bytes (${fr.apngVerify.frameCount} frames ` +
        `${fr.meta.width}x${fr.meta.height}), opus ${fr.meta.opusBytes} bytes ` +
        `(${fr.opusVerify.durationSec?.toFixed?.(2)}s @ ${fr.opusVerify.sampleRate}Hz)`
    );
    console.log('wrote:');
    console.log('  ' + outAv1);
    console.log('  ' + outApng);
    console.log('  ' + outOpus);
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
