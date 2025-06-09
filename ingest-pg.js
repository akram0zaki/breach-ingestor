#!/usr/bin/env node

/**
 * ingest.js
 *
 * Recursively scans all .txt files under a root directory at any depth,
 * parses email/password pairs (any order, various delimiters),
 * detects hash types, and bulk-inserts into Postgres.
 *
 * If STAGING=true in .env (default false), data is loaded into a staging table first,
 * then merged into the main table with duplicate-skipping via ON CONFLICT.
 * Otherwise, data is imported directly into the main table without deduplication.
 * * Maintains a progress file (via PROGRESS_FILE_NAME) to resume on interruption.
 *
 * Safe stop mechanism:
 * - Linux/macOS: Send SIGTERM or SIGINT (Ctrl+C)
 * - Windows/All: Create a file named 'STOP_INGESTION' in the script directory
 * - Process will complete current file before stopping gracefully
 *
 * Timestamps are logged for benchmarking:
 * - Job start
 * - File processing start/skip
 * - Line-level progress every PROGRESS_INTERVAL rows
 * - File import complete
 * - Job finish
 * 
 * Logging levels controlled by DEBUG env flag:
 * - info: startup, file start/skip, import complete
 * - debug: per-PROGRESS_INTERVAL progress updates
 *  
 * To install the dependencies:
 * npm install pg fast-glob split2 pg-copy-streams dotenv
*/

import fg from 'fast-glob';
import fs from 'fs';
import readline from 'readline';
import { PassThrough } from 'stream';
import { Client } from 'pg';
import copyFrom from 'pg-copy-streams';
import 'dotenv/config';
import path from 'path';

// Config
const DATA_ROOT = process.env.INPUT_DIR || '/mnt/nas/breaches';
const PG = {
  user:     process.env.PG_USER     || 'pi',
  host:     process.env.PG_HOST     || 'localhost',
  database: process.env.PG_DATABASE || 'breachdb',
  port:     parseInt(process.env.PG_PORT, 10) || 5432,
  password: process.env.PG_PASSWORD
};
const PROGRESS_FILE_NAME = process.env.PROGRESS_FILE_NAME || 'ingest-progress.json';
const PROGRESS_FILE = path.resolve(PROGRESS_FILE_NAME);
const SKIPPED_LOG   = process.env.SKIPPED_LOG   || 'skipped.log';
const PROGRESS_INTERVAL = parseInt(process.env.PROGRESS_INTERVAL, 10) || 10000;
const DEBUG = process.env.DEBUG === 'true';
const USE_STAGING = process.env.STAGING === 'true';

// Safe stop mechanism
const STOP_FILE = 'STOP_INGESTION';
let shouldStop = false;

// Signal handlers (Unix-like systems)
process.on('SIGTERM', () => {
  log(`[${new Date().toISOString()}] SIGTERM received, will stop after current file completes...`);
  shouldStop = true;
});

process.on('SIGINT', () => {
  log(`[${new Date().toISOString()}] SIGINT received, will stop after current file completes...`);
  shouldStop = true;
});

// Check for stop requests (cross-platform)
function checkForStopRequest() {
  if (shouldStop) return true;
  if (fs.existsSync(STOP_FILE)) {
    log(`[${new Date().toISOString()}] Stop file detected, will stop after current file completes...`);
    shouldStop = true;
    return true;
  }
  return false;
}

// Logging
const log = (...args) => console.info(...args);
const debugLog = DEBUG ? (...args) => console.debug(...args) : () => {};

log(`[${new Date().toISOString()}] Using progress file: ${PROGRESS_FILE}`);
log(`[${new Date().toISOString()}] STAGING ${USE_STAGING ? 'enabled' : 'disabled'}`);
log(`[${new Date().toISOString()}] Safe stop: Send SIGTERM/SIGINT or create '${STOP_FILE}' file`);

// Load processed file list
let processed = new Set();
if (fs.existsSync(PROGRESS_FILE)) {
  try { processed = new Set(JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))); }
  catch { log(`[${new Date().toISOString()}] Warning: invalid progress file, starting fresh.`); }
}

// Initialize DB
const pg = new Client(PG);
await pg.connect();

// Ensure tables and index
if (USE_STAGING) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS breaches_stage (
      email_norm TEXT, raw_email TEXT, password TEXT,
      is_hash BOOLEAN, hash_type TEXT, source TEXT
    );
  `);
  try {
    await pg.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_breach
      ON breaches(email_norm, password, source);
    `);
    log(`[${new Date().toISOString()}] Unique index ensured.`);
  } catch (e) {
    log(`[${new Date().toISOString()}] Could not create unique index: ${e.message}`);
  }
} else {
  try {
    await pg.query('DROP INDEX IF EXISTS idx_unique_breach');
    log(`[${new Date().toISOString()}] Unique index dropped for direct load mode.`);
  } catch (e) {
    log(`[${new Date().toISOString()}] Warning: dropping unique index failed: ${e.message}`);
  }
}
await pg.query(`
  CREATE TABLE IF NOT EXISTS breaches (
    id BIGSERIAL PRIMARY KEY,
    email_norm TEXT NOT NULL,
    raw_email TEXT NOT NULL,
    password TEXT NOT NULL,
    is_hash BOOLEAN NOT NULL,
    hash_type TEXT NOT NULL,
    source TEXT NOT NULL
  );
`);

log(`[${new Date().toISOString()}] Ingest job started`);

// Discover files
const files = await fg([`${DATA_ROOT}/**/*.txt`, `${DATA_ROOT}/**/*.TXT`], { caseSensitiveMatch: false });
log(`[${new Date().toISOString()}] Discovered ${files.length} files`);

// Process each file with resilience
for (const file of files) {
  // Check for stop request before processing each file
  if (checkForStopRequest()) {
    log(`[${new Date().toISOString()}] Stop requested - gracefully terminating after processing ${processed.size} files`);
    log(`[${new Date().toISOString()}] Remaining files: ${files.length - processed.size}`);
    break;
  }

  if (processed.has(file)) {
    log(`[${new Date().toISOString()}] Skipping processed: ${file}`);
    continue;
  }

  try {
    log(`[${new Date().toISOString()}] Processing: ${file}`);    // Detect delimiter & order (check second line in case first is header)
    const fd = fs.createReadStream(file);
    const rlD = readline.createInterface({ input: fd });
    let delim, order;
    let lineCount = 0;
    for await (const line of rlD) {
      const L = line.trim(); 
      if (!L) continue;
      lineCount++;
      
      // Skip first line, analyze second line for format detection
      if (lineCount === 1) continue;
      
      delim = L.includes(':') ? ':' : L.includes(';') ? ';' : ' ';
      
      // Check if second record has more than 2 fields - skip entire file if so
      const fields = L.split(delim);
      if (fields.length > 2) {
        rlD.close(); fd.destroy();
        fs.appendFileSync(SKIPPED_LOG, `${file} – record 2 contains more than 2 fields\n`);
        throw new Error('file skipped - invalid record format');
      }
      
      const [a,b] = L.split(delim,2).map(s=>s.trim());
      order = /\S+@\S+\.\S+/.test(a) ? ['email','pw'] : ['pw','email'];
      break;
    }
    rlD.close(); fd.destroy();
    if (!delim || !order) throw new Error('undetectable format');    // Prepare COPY
    const target = USE_STAGING ? 'breaches_stage' : 'breaches';
    const copySql = `COPY ${target}(email_norm, raw_email, password, is_hash, hash_type, source) FROM STDIN WITH (FORMAT csv)`;
    const pass = new PassThrough();
    const copyStream = pg.query(copyFrom.from(copySql));
    const copyDone = new Promise((res, rej) => {
      copyStream.on('finish', res);
      copyStream.on('error', (err) => {
        log(`[${new Date().toISOString()}] COPY stream error for file ${file}: ${err.message}`);
        rej(err);
      });
    });
    pass.pipe(copyStream);    // Stream lines and write
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    let count=0;
    let skippedRecords = 0;
    for await (let line of rl) {
      const clean = line.replace(/[\x00-\x1F\x7F]/g,'').trim();
      if (!clean) continue;
        const fields = clean.split(delim);
      
      // Skip records with wrong field count
      if (fields.length !== 2) {
        skippedRecords++;
        debugLog(`[${new Date().toISOString()}] Skipping record with ${fields.length} fields in ${file}`);
        continue;
      }
      
      const [r1,r2] = fields.map(s=>s.trim());
      const email = order[0]==='email'?r1:r2;
      const pw    = order[0]==='pw'?   r1:r2;
      
      // Skip records with empty fields
      if (!email || !pw) {
        skippedRecords++;
        debugLog(`[${new Date().toISOString()}] Skipping record with empty fields in ${file}`);
        continue;
      }
      
      // Skip records that are too long (PostgreSQL index row size limit is ~8KB)
      const totalLength = email.length + pw.length + file.length;
      if (totalLength > 4000) { // Conservative limit to avoid index issues
        skippedRecords++;
        debugLog(`[${new Date().toISOString()}] Skipping oversized record in ${file}: total length ${totalLength}`);
        continue;
      }
      
      const norm  = email.toLowerCase().split('+')[0];
      let is_hash=false, hash_type='plaintext';
      if (/^[0-9a-f]{32}$/i.test(pw)) is_hash=true, hash_type='md5';
      else if (/^[0-9a-f]{40}$/i.test(pw)) is_hash=true, hash_type='sha1';
      else if (/^\$2[aby]\$/.test(pw)) is_hash=true, hash_type='bcrypt';
      const esc=v=>`"${String(v).replace(/"/g,'""')}"`;
      pass.write([norm,email,pw,is_hash,hash_type,file].map(esc).join(',')+'\n');
      if (++count % PROGRESS_INTERVAL === 0) debugLog(`[${new Date().toISOString()}] ${count} rows parsed`);
    }    rl.close(); pass.end();

    try {
      await copyDone;
    } catch (copyError) {
      log(`[${new Date().toISOString()}] COPY operation failed for ${file}: ${copyError.message}`);
      // Clean up staging table if needed
      if (USE_STAGING) {
        try {
          await pg.query('TRUNCATE breaches_stage');
        } catch (truncateError) {
          log(`[${new Date().toISOString()}] Warning: failed to truncate staging table: ${truncateError.message}`);
        }
      }
      throw copyError; // Re-throw to be handled by outer catch
    }
    
    if (USE_STAGING) {
      await pg.query(`INSERT INTO breaches(email_norm, raw_email, password, is_hash, hash_type, source)
                     SELECT email_norm, raw_email, password, is_hash, hash_type, source FROM breaches_stage
                     ON CONFLICT(email_norm,password,source) DO NOTHING`);
      await pg.query('TRUNCATE breaches_stage');
    }
    
    const skippedMsg = skippedRecords > 0 ? ` (${skippedRecords} oversized records skipped)` : '';
    log(`[${new Date().toISOString()}] Imported ${count} rows from ${file}${skippedMsg}`);
  } catch (err) {
    // Graceful error: log and continue
    log(`[${new Date().toISOString()}] Error processing ${file}: ${err.message}`);
    fs.appendFileSync(SKIPPED_LOG, `${file} – ${err.message}\n`);
  }

  // Mark file done and persist
  processed.add(file);  fs.writeFileSync(PROGRESS_FILE, JSON.stringify([...processed], null, 2));
}

// Clean up stop file if it exists
if (fs.existsSync(STOP_FILE)) {
  try {
    fs.unlinkSync(STOP_FILE);
    log(`[${new Date().toISOString()}] Cleaned up stop file`);
  } catch (e) {
    log(`[${new Date().toISOString()}] Warning: could not clean up stop file: ${e.message}`);
  }
}

await pg.end();
if (shouldStop) {
  log(`[${new Date().toISOString()}] Ingestion stopped gracefully, progress saved to ${PROGRESS_FILE}`);
} else {
  log(`[${new Date().toISOString()}] Ingestion complete, progress saved to ${PROGRESS_FILE}`);
}
