#!/usr/bin/env node

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';

// Load HMAC key from .env
const EMAIL_KEY = Buffer.from(process.env.EMAIL_HASH_KEY, 'hex');

// Path to log file for entries with more than two fields
const LOG_PATH = path.join(process.cwd(), 'multi_field_files.log');

// Track seen entries across calls (in-memory)
const seen = new Set();

// Normalize email: trim, lowercase, remove leading symbols, strip +tags
function normalizeEmail(email) {
  let e = email.trim().toLowerCase();
  e = e.replace(/^[^a-z0-9]+/, '');
  const atIndex = e.indexOf('@');
  if (atIndex > 0) {
    let local = e.slice(0, atIndex).split('+')[0];
    const domain = e.slice(atIndex + 1);
    e = `${local}@${domain}`;
  }
  return e;
}

// Compute HMAC-SHA256 of normalized email
function hashEmail(email) {
  const normalized = normalizeEmail(email);
  return crypto
    .createHmac('sha256', EMAIL_KEY)
    .update(normalized)
    .digest('hex');
}

// Detect if a credential string is a hash and determine its type
function detectHash(value) {
  const pw = value.trim();
  if (/^\$(2[aby])\$\d{2}\$[A-Za-z0-9./]{53}$/.test(pw)) return { is_hash: true, hash_type: 'bcrypt' };
  if (/^\$argon2(?:i|d|id)\$v=\d+\$.*\$.*\$.*$/.test(pw))   return { is_hash: true, hash_type: 'argon2' };
  const m = pw.match(/^\$(1|5|6)\$([^$]+)\$([A-Za-z0-9./]+)$/);
  if (m) { const map = { '1':'md5-crypt','5':'sha256-crypt','6':'sha512-crypt' }; return { is_hash: true, hash_type: map[m[1]] }; }
  if (/^\{SSHA\}[A-Za-z0-9+\/=]+$/.test(pw)) return { is_hash: true, hash_type: 'ssha' };
  if (/^\{SHA\}[A-Za-z0-9+\/=]+$/.test(pw))  return { is_hash: true, hash_type: 'sha1-base64' };
  if (/^[A-Fa-f0-9]+$/.test(pw)) {
    switch (pw.length) {
      case 32:  return { is_hash: true, hash_type: 'md5-hex' };
      case 40:  return { is_hash: true, hash_type: 'sha1-hex' };
      case 64:  return { is_hash: true, hash_type: 'sha256-hex' };
      case 128: return { is_hash: true, hash_type: 'sha512-hex' };
    }
  }
  return { is_hash: false, hash_type: 'plaintext' };
}

// Process a single .txt file and emit JSONL, logging multi-field files
async function processFile(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { highWaterMark: 64 * 1024 }),
    crlfDelay: Infinity
  });
  let loggedMulti = false;

  for await (const line of rl) {
    let rawEmail, rawPassword;
    let fieldCount = 0;
    const colonIndex = line.indexOf(':');

    if (colonIndex >= 0) {
      // Split at first colon; count total colons
      rawEmail = line.slice(0, colonIndex);
      rawPassword = line.slice(colonIndex + 1);
      fieldCount = line.split(':').length;
    } else {
      // Split on whitespace; count all tokens
      const parts = line.trim().split(/[:;\s]+/);
      rawEmail = parts[0];
      rawPassword = parts[1] || '';
      fieldCount = line.trim().split(/\s+/).length;
    }

    // Log filePath if more than two fields and not yet logged
    if (!loggedMulti && fieldCount > 2) {
      fs.appendFileSync(LOG_PATH, `${filePath}\n`);
      loggedMulti = true;
    }

    if (!rawEmail) continue;
    const emailNorm = normalizeEmail(rawEmail);
    if (!emailNorm.includes('@')) continue;

    const email_hash = hashEmail(emailNorm);
    const password = rawPassword.trim();
    const { is_hash, hash_type } = detectHash(password);
    const source = filePath;

    const dedupKey = `${email_hash}:${password}:${source}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Emit record with new order
    const record = {
      email_hash,
      password,
      is_hash,
      hash_type,
      email: emailNorm,
      source
    };
    console.log(JSON.stringify(record));
  }
}

// Recursively gather .txt files under a directory
function findTxtFiles(dir) {
  let results = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      results = results.concat(findTxtFiles(fullPath));
    } else if (ent.isFile() && ent.name.endsWith('.txt')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Main entrypoint
(async function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0) {
    console.error('Usage: node parse-and-hash.js <fileOrDirectory> [...]');
    process.exit(1);
  }

  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      console.error(`Path not found: ${input}`);
      continue;
    }
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      for (const file of findTxtFiles(input)) {
        await processFile(file);
      }
    } else if (stat.isFile()) {
      await processFile(input);
    }
  }
})();
