import 'dotenv/config';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import readline from 'readline';

// Configuration
const ROOT = process.env.INPUT_DIR || '/mnt/Torrents/WDHome/breaches';
const SHARD_DIR = process.env.SHARD_DIR || '/mnt/Torrents/WDHome/data/shards';
const PROGRESS_FILE = path.join(SHARD_DIR, 'ingest-progress.json');
const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '64', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '500', 10);
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS || '2000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '2', 10);

const LEVELS = { ERROR: 0, INFO: 1, DEBUG: 2 };
const CURRENT_LEVEL = process.env.LOG_LEVEL
  ? LEVELS[process.env.LOG_LEVEL.toUpperCase()] 
  : LEVELS.INFO;

function log(level, ...args) {
  if (LEVELS[level] <= CURRENT_LEVEL) {
    console.log(...args);
  }
}

log('INFO', 'Log level=' + CURRENT_LEVEL)

// Ensure directories exist
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
}
ensureDir(SHARD_DIR);
ensureDir(path.dirname(PROGRESS_FILE));

// Load HMAC key for email hashing
const EMAIL_KEY = Buffer.from(process.env.EMAIL_HASH_KEY || '', 'hex');
if (!EMAIL_KEY || EMAIL_KEY.length !== 32) {
  console.error('Invalid EMAIL_HASH_KEY; must be 32-byte hex in .env');
  process.exit(1);
}

// Normalize email before hashing
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
  return crypto.createHmac('sha256', EMAIL_KEY)
    .update(normalizeEmail(email))
    .digest('hex');
}

// Detect if a credential is a hash
function detectHash(value) {
  const pw = value.trim();
  if (/^\$(2[aby])\$\d{2}\$[A-Za-z0-9./]{53}$/.test(pw)) return { is_hash: true, hash_type: 'bcrypt' };
  if (/^\$argon2(?:i|d|id)\$v=\d+\$.*\$.*\$.*$/.test(pw)) return { is_hash: true, hash_type: 'argon2' };
  const m = pw.match(/^\$(1|5|6)\$([^$]+)\$([A-Za-z0-9./]+)$/);
  if (m) {
    const map = { '1':'md5-crypt','5':'sha256-crypt','6':'sha512-crypt' };
    return { is_hash: true, hash_type: map[m[1]] };
  }
  if (/^\{SSHA\}[A-Za-z0-9+/=]+$/.test(pw)) return { is_hash: true, hash_type: 'ssha' };
  if (/^\{SHA\}[A-Za-z0-9+/=]+$/.test(pw))  return { is_hash: true, hash_type: 'sha1-base64' };
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

// Load or initialize progress
let progress = {};
if (fs.existsSync(PROGRESS_FILE)) {
  try {
    const data = fs.readFileSync(PROGRESS_FILE, 'utf8') || '{}';
    progress = JSON.parse(data);
  } catch (err) {
    console.error('Error reading progress file:', err);
  }
}

// Persist progress
function saveProgress() {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch (err) {
    console.error('Failed saving progress file:', err);
  }
}
// Promisified fsync
const fsync = promisify(fs.fsync);

// BatchWriter buffers writes and flushes at intervals or batch size
class BatchWriter {
  constructor(rawWs) {
    this.ws = rawWs;
    this.queue = [];
    this.closed = false;
    // schedule periodic flushes
    this.timer = setInterval(() => this.flush(), BATCH_INTERVAL_MS);
  }
  write(line) {
    if (this.closed) return Promise.resolve();
    this.queue.push(line);
    if (this.queue.length >= BATCH_SIZE) {
      return this.flush();
    }
    return Promise.resolve();
  }
  async flush() {
    // DEBUG: log number of lines being flushed and path
    log('DEBUG', `[BatchWriter] flushing ${this.queue.length} lines to ${this.ws.path}`);
    if (!this.queue.length) return;
    const data = this.queue.join('\n') + '\n';
    this.queue.length = 0;

    // write and optionally fsync
    await new Promise((resolve, reject) => {
      this.ws.write(data, async err => {
        if (err) return reject(err);

        // only attempt fsync if stream is still open
        if (this.ws.destroyed || typeof this.ws.fd !== 'number') {
          return resolve();
        }

        try {
          // ensure data reaches disk
          await fsync(this.ws.fd);
        } catch (fsyncErr) {
          // swallow only bad-fd errors, log others
          if (fsyncErr.code !== 'EBADF') {
            console.error('fsync error:', fsyncErr);
          }
        }
        resolve();
      });
    });
  }
  async end() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);   // stop the periodic flush
    await this.flush();          // flush any remaining data
    this.ws.end();               // close underlying stream
  }
}

// LRUStreams maintains up to limit open write streams
class LRUStreams {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
    this.head = this.tail = null;
  }
  _remove(node) {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (this.head === node) this.head = node.next;
    if (this.tail === node) this.tail = node.prev;
    node.prev = node.next = null;
  }
  _add(node) {
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }
  async _evict() {
    if (this.map.size < this.limit) return;
    // DEBUG: log eviction details
    log('DEBUG', `[LRU] map.size=${this.map.size} ≥ limit=${this.limit}, evicting tail=${this.tail?.prefix}`);
    if (this.map.size < this.limit) return;
    const lru = this.tail;
    this._remove(lru);
    const entry = this.map.get(lru.prefix);
    this.map.delete(lru.prefix);
    if (entry) {
      try { await entry.writer.end(); }
      catch (e) { console.error('Error ending writer:', e); }
    }
  }

  async get(prefix) {
    await this._evict();
    if (this.map.has(prefix)) {
      const { writer,node } = this.map.get(prefix);
      this._remove(node);
      this._add(node);
      return writer;
    }
    const subdir = prefix.slice(0,2);
    const dir = path.join(SHARD_DIR, subdir);
    ensureDir(dir);
    const filePath = path.join(dir, `${prefix}.jsonl`);
    const raw = fs.createWriteStream(filePath, { flags: 'a' });
    raw.on('error', e => console.error(`Shard write error ${filePath}:`, e));
    const writer = new BatchWriter(raw);
    const node = { prefix, prev:null, next:null };
    this._add(node);
    this.map.set(prefix, { writer, raw, node });
    return writer;
  }
  async closeAll() {
    const ends = [];
    for (const { writer } of this.map.values()) {
      ends.push(writer.end());
    }
    this.map.clear(); this.head=this.tail=null;
    await Promise.all(ends);
  }
}

const cache = new LRUStreams(MAX_STREAMS);

// Recursively find .txt files under ROOT
function findTxtFiles(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(findTxtFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.txt')) {
      files.push(fullPath);
    }
  }
  return files;
}

// Process each file line by line
async function processFile(filePath) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const rl = readline.createInterface({ input: stream });
  for await (const str of rl) {
    if (!str) continue;
    try {
      const sep = str.indexOf(':');
      if (sep < 1) continue;
      const rawEmail = str.slice(0, sep);
      const rawPass = str.slice(sep + 1);
      const emailNorm = rawEmail.toLowerCase().trim();
      if (!emailNorm.includes('@')) continue;
      const email_hash = hashEmail(rawEmail);
      const { is_hash, hash_type } = detectHash(rawPass);
      const rec = { email_hash, password: rawPass, is_hash, hash_type, email: emailNorm, source: filePath };
      const writer = await cache.get(email_hash.slice(0,4));
      await writer.write(JSON.stringify(rec));
    } catch (e) {
      console.error('Line processing error:', e);
    }
  }
}


// Main execution
(async()=>{
  log('INFO', '==== RUN START:' + new Date().toISOString() + '====');
  const files = findTxtFiles(ROOT);
  let index = 0;
  const total = files.length;
  // DEBUG SETTINGS
  log('INFO', `==== DEBUG SETTINGS ====`);
  log('INFO', `ROOT=${ROOT}  SHARD_DIR=${SHARD_DIR}`);
  log('INFO', `CONCURRENCY=${CONCURRENCY}  MAX_STREAMS=${MAX_STREAMS}  BATCH_SIZE=${BATCH_SIZE}  BATCH_INTERVAL_MS=${BATCH_INTERVAL_MS}`);
  log('INFO', `Discovered ${total} .txt files in ROOT`);

  const worker = async (id) => {
    while (true) {
      const i = index++;
      const file = files[i];
      log('DEBUG', `[worker ${id}] picked index=${i} → ${file}`);
      if (!file) break;
      if (progress[file] === 'done') {
        log('DEBUG', `[worker ${id}] skipping already done: ${file}`);
        continue;
      }
	  log('INFO', `[${new Date().toISOString()}] Picking up file: ${file}`);
      progress[file] = 'in-progress';
      saveProgress();
      try {
        await processFile(file);
        progress[file] = 'done';
        saveProgress();
      } catch (e) {
        console.error(`Error processing ${file}:`, e);
      }
    }
  };

  // Launch concurrent workers
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);

  // Close all open shard streams
  await cache.closeAll();

  //spawnSync('bash', ['-c', `gzip -k -f ${SHARD_DIR}/*/*.jsonl`], { stdio: 'inherit' });

  // Compress shards individually to avoid argument list too long
  // log('INFO', 'Compressing shards individually...');
  // const subdirs = fs.readdirSync(SHARD_DIR, { withFileTypes: true })
  //   .filter(d => d.isDirectory())
  //   .map(d => path.join(SHARD_DIR, d.name));
  // for (const dir of subdirs) {
  //   const files = fs.readdirSync(dir)
  //     .filter(f => f.endsWith('.jsonl'))
  //     .map(f => path.join(dir, f));
  //   for (const file of files) {
  //     log('DEBUG', `gzip: ${file}`);
  //     spawnSync('gzip', ['-k', '-f', file], { stdio: 'inherit' });
  //   }
  // }

  log('INFO', '==== RUN COMPLETE:' + new Date().toISOString() + '====');
  process.exit(0);
})();
