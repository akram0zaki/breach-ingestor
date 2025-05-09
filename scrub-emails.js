#!/usr/bin/env node

/**
 * scrub-emails.js
 *
 * Scans through all shards under SHARD_DIR (subfolders 00-ff),
 * and for each .jsonl or .jsonl.gz file, rewrites it in-place
 * with the "email" field set to an empty string for privacy.
 *
 * Usage:
 *   SHARD_DIR=/path/to/shards node scrub-emails.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';

const shardDir = process.env.SHARD_DIR;
if (!shardDir) {
  console.error('Please set SHARD_DIR in environment.');
  process.exit(1);
}

async function processFile(filePath) {
  const isGz = filePath.endsWith('.jsonl.gz');
  const tempPath = filePath + '.tmp';
  const readStream = fs.createReadStream(filePath);
  const input = isGz ? readStream.pipe(zlib.createGunzip()) : readStream;
  const writeRaw = fs.createWriteStream(tempPath);
  const output = isGz ? writeRaw.pipe(zlib.createGzip()) : writeRaw;

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const rec = JSON.parse(line);
      rec.email = '';  // scrub cleartext email
      output.write(JSON.stringify(rec) + '\n');
    } catch (e) {
      // on parse error, copy original line
      output.write(line + '\n');
    }
  }

  // finish and replace original
  await new Promise(res => output.end(res));
  fs.renameSync(tempPath, filePath);
  console.log('Processed:', filePath);
}

async function walkAndScrub(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (let ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkAndScrub(full);
    } else if (ent.isFile() && (ent.name.endsWith('.jsonl') || ent.name.endsWith('.jsonl.gz'))) {
      await processFile(full);
    }
  }
}

(async () => {
  console.log('Starting scrub of email fields in shards under', shardDir);
  await walkAndScrub(shardDir);
  console.log('Done scrubbing shards.');
})();
