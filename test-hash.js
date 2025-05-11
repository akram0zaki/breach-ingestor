#!/usr/bin/env node

import 'dotenv/config';
import crypto from 'crypto';

const [,, email] = process.argv;
if (!email) {
  console.error('Usage: node test-hash.js <email>');
  process.exit(1);
}

const EMAIL_KEY = Buffer.from(process.env.EMAIL_HASH_KEY, 'hex');
console.log('HMAC key:', EMAIL_KEY);

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

// Normalize and HMAC-SHA256 the email
const emailHash = hashEmail(email)

console.log(`Looking up email: ${email}`);
console.log(`Hash: ${emailHash}`);
