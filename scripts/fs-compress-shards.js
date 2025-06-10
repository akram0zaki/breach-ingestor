#!/usr/bin/env node

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';

const SHARD_DIR = process.env.SHARD_DIR;
if (!SHARD_DIR) {
  console.error('ERROR: set SHARD_DIR in environment or .env');
  process.exit(1);
}

async function compressFile(filePath) {
  const gzPath = filePath + '.gz';
  try {
    await pipeline(
      fs.createReadStream(filePath),
      zlib.createGzip(),
      fs.createWriteStream(gzPath, { flags: 'wx' })
    );
    await fs.promises.unlink(filePath);
    console.log(`✓ ${path.relative(SHARD_DIR, filePath)} → ${path.relative(SHARD_DIR, gzPath)}`);
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.warn(`⚠️  Skipping already-compressed: ${path.relative(SHARD_DIR, gzPath)}`);
    } else {
      console.error(`✗ Error compressing ${filePath}:`, err.message);
    }
  }
}

async function walkAndCompress(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkAndCompress(full);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      await compressFile(full);
    }
  }
}

(async () => {
  console.log(`Starting compression in ${SHARD_DIR}`);
  await walkAndCompress(SHARD_DIR);
  console.log('Done.');
})();
