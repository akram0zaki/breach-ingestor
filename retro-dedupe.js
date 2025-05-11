#!/usr/bin/env node

/**
 * retro-dedupe.js
 *
 * Retroactively deduplicates entries in existing shards.
 * Keeps only the first occurrence of each unique combination:
 *    email_hash + password + source
 *
 * Supports both .jsonl and .jsonl.gz files.
 * Resilient to interruptions: tracks processed files in dedupe-progress.json.
 *
 * Usage:
 *   SHARD_DIR=/path/to/shards node retro-dedupe.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';

const SHARD_DIR = process.env.SHARD_DIR;
if (!SHARD_DIR) {
  console.error('Please set SHARD_DIR in the environment.');
  process.exit(1);
}

const PROGRESS_PATH = path.join(SHARD_DIR, 'dedupe-progress.json');
let progress = {};
if (fs.existsSync(PROGRESS_PATH)) {
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch {
    console.warn('Could not read progress file; starting fresh.');
  }
}

function saveProgress() {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

async function dedupeFile(filePath) {
  if (progress[filePath]) return; // already done

  const isGz = filePath.endsWith('.gz');
  const tmpPath = filePath + '.tmp';
  const seen = new Set();

  try {
    const inStream = fs.createReadStream(filePath);
    const reader = readline.createInterface({
      input: isGz ? inStream.pipe(zlib.createGunzip()) : inStream,
      crlfDelay: Infinity,
    });

    const outRaw = fs.createWriteStream(tmpPath);
    const output = isGz ? zlib.createGzip() : outRaw;
    if (isGz) output.pipe(outRaw);

    for await (const line of reader) {
      try {
        const record = JSON.parse(line);
        const key = `${record.email_hash}:${record.password}:${record.source}`;
        if (!seen.has(key)) {
          seen.add(key);
          output.write(JSON.stringify(record) + '\n');
        }
      } catch {
        output.write(line + '\n'); // preserve malformed line
      }
    }

    await new Promise(res => output.end(res));
    fs.renameSync(tmpPath, filePath); // safely replace
    progress[filePath] = true;
    saveProgress();
    console.log('Deduplicated:', filePath);
  } catch (err) {
    console.error('Failed on:', filePath, err.message);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); // cleanup
  }
}

async function walkShards(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkShards(full);
    } else if ((ent.name.endsWith('.jsonl') || ent.name.endsWith('.jsonl.gz')) && !progress[full]) {
      await dedupeFile(full);
    }
  }
}

(async () => {
  console.log('Starting retroactive deduplication in:', SHARD_DIR);
  await walkShards(SHARD_DIR);
  console.log('Deduplication complete.');
})();
