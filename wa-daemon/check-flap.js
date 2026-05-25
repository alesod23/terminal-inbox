#!/usr/bin/env node
// Detect WA daemon flap storms by scanning the last 300 lines of daemon.log.
// Output (one line of JSON): {"disc5m":N,"replaced60m":N,"lastReason":"<reason>"}
//
// disc5m       = total disconnects in the last 5 minutes
// replaced60m  = "connectionReplaced" disconnects in the last 60 minutes
// lastReason   = reason string from the most recent connectionReplaced (or "")
//
// Used by the /triage skill (step 2) to decide whether to print the flap banner.
// Threshold: warn if disc5m >= 3 OR replaced60m >= 1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, 'daemon.log');

let lines;
try {
  lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-300);
} catch (err) {
  // No log yet (fresh daemon) -> no flap
  console.log(JSON.stringify({ disc5m: 0, replaced60m: 0, lastReason: '' }));
  process.exit(0);
}

const now = Date.now();
const cutoff5 = now - 5 * 60 * 1000;
const cutoff60 = now - 60 * 60 * 1000;

let disc5m = 0;
let replaced60m = 0;
let lastReason = '';

for (const line of lines) {
  const m = line.match(/^\[([^\]]+)\]\s+disconnected.*code=(\d+)\s+(\w+)/);
  if (!m) continue;
  const t = Date.parse(m[1]);
  if (isNaN(t)) continue;
  if (t >= cutoff5) disc5m++;
  if (t >= cutoff60 && m[3] === 'connectionReplaced') {
    replaced60m++;
    lastReason = 'connectionReplaced';
  }
}

console.log(JSON.stringify({ disc5m, replaced60m, lastReason }));
