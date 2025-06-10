#!/usr/bin/env node

/**
 * merge-shards.js
 *
 * Merge shard files from multiple directories into a base shard directory, with status reporting and resume support.
 * Progress file remains after completion with statuses for audit.
 * 
 * Usage:
 *   SHARD_DIRS=/path/to/base,/path/to/other1,/path/to/other2 node merge-shards.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';

// Recursive directory walker
async function walk(dir, callback) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, callback);
    } else if (entry.isFile()) {
      await callback(fullPath);
    }
  }
}

async function main() {
  const { SHARD_DIRS } = process.env;
  if (!SHARD_DIRS) {
    console.error('ERROR: Please set SHARD_DIRS in environment (.env)');
    process.exit(1);
  }

  const dirs = SHARD_DIRS.split(',').map(s => s.trim()).filter(Boolean);
  if (dirs.length < 2) {
    console.error('ERROR: Need at least two directories to merge');
    process.exit(1);
  }

  const [baseDir, ...otherDirs] = dirs;
  const progressFile = path.join(baseDir, '.merge-progress.json');
  let progress = {};

  // Load existing progress or initialize
  if (fs.existsSync(progressFile)) {
    try {
      progress = JSON.parse(await fs.promises.readFile(progressFile, 'utf8'));
    } catch (e) {
      console.error('ERROR reading progress file:', e);
      process.exit(1);
    }
  }

  // Gather tasks
  const tasks = [];
  for (const srcRoot of otherDirs) {
    await walk(srcRoot, async (srcPath) => {
      if (!srcPath.endsWith('.jsonl') && !srcPath.endsWith('.jsonl.gz')) return;
      const rel = path.relative(srcRoot, srcPath).replace(/\.gz$/, '');
      const destPath = path.join(baseDir, path.dirname(rel), path.basename(rel));
      tasks.push({ srcRoot, srcPath, destPath, isGzip: srcPath.endsWith('.gz') });
    });
  }

  const total = tasks.length;
  console.log(`Found ${total} shard files to merge.`);

  for (let i = 0; i < tasks.length; i++) {
    const { srcRoot, srcPath, destPath, isGzip } = tasks[i];
    const key = srcPath;
    const status = progress[key] && progress[key].status;

    if (status === 'done') {
      console.log(`[${i+1}/${total}] Skipping done: ${srcPath}`);
      continue;
    }
    if (status !== 'in-progress') {
      progress[key] = { status: 'in-progress', timestamp: new Date().toISOString() };
      await fs.promises.writeFile(progressFile, JSON.stringify(progress, null, 2));
    }
    console.log(`[${i+1}/${total}] Merging: ${srcPath}`);

    // Ensure destination directory
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    try {
      const srcStream = isGzip
        ? fs.createReadStream(srcPath).pipe(zlib.createGunzip())
        : fs.createReadStream(srcPath);
      const destStream = fs.createWriteStream(destPath, { flags: 'a' });
      await pipeline(srcStream, destStream);

      progress[key] = { status: 'done', mergedAt: new Date().toISOString() };
      await fs.promises.writeFile(progressFile, JSON.stringify(progress, null, 2));
      console.log(`[${i+1}/${total}] Done: ${srcPath}`);
    } catch (e) {
      console.error(`[${i+1}/${total}] ERROR merging ${srcPath}:`, e);
      process.exit(1);
    }
  }

  console.log('Shard merge processing complete. Progress file retained for audit.');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
