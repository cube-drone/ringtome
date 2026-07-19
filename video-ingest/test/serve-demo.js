// serve-demo.js — `npm run demo`
//
// Serves the project over http://127.0.0.1 (a secure context, so WebCodecs
// works) and prints the demo URL. Ctrl-C to stop.

import { startServer } from './static-server.js';

const { base } = await startServer();
console.log(`\nvideo-ingest demo running:\n  ${base}/demo/index.html\n`);
console.log('(serve over http/loopback so WebCodecs is enabled; file:// will not work)');
console.log('Press Ctrl-C to stop.');
