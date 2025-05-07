import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';

// Configuration
const ROOT = process.env.INPUT_DIR || '/mnt/Torrents/WDHome/breaches';
const SHARD_DIR = process.env.SHARD_DIR || '/mnt/Torrents/WDHome/data/shards';
const PROGRESS_FILE = path.join(SHARD_DIR, 'ingest-progress.json');
const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '100', 10);

// Ensure base shard directory
if (!fs.existsSync(SHARD_DIR)) {
  fs.mkdirSync(SHARD_DIR, { recursive: true });
}

// Load or initialize progress
let progress = {};
if (fs.existsSync(PROGRESS_FILE)) {
  try {
    const data = fs.readFileSync(PROGRESS_FILE, 'utf8').trim();
    progress = data ? JSON.parse(data) : {};
  } catch (err) {
    console.warn('Warning: could not parse progress file, resetting.');
    progress = {};
  }
}
fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

// Persist progress helper
function saveProgress() {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// LRU cache of write streams, writing shards into 256 subdirs
class LRUStreams {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map(); // prefix -> { ws, node }
    this.head = null; // MRU
    this.tail = null; // LRU
  }
  _remove(node) {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (this.head === node) this.head = node.next;
    if (this.tail === node) this.tail = node.prev;
  }
  _addToHead(node) {
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }
  get(prefix) {
    let entry = this.map.get(prefix);
    if (entry) {
      this._remove(entry.node);
      this._addToHead(entry.node);
      return entry.ws;
    }
    // Evict LRU if at limit
    if (this.map.size >= this.limit) {
      const lru = this.tail;
      this._remove(lru);
      const old = this.map.get(lru.prefix);
      old.ws.end();
      this.map.delete(lru.prefix);
    }
    // Ensure subdir
    const sub = prefix.slice(0,2);
    const dir = path.join(SHARD_DIR, sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${prefix}.jsonl`);
    const ws = fs.createWriteStream(filePath, { flags: 'a' });
    const node = { prefix, ws, prev: null, next: null };
    this._addToHead(node);
    this.map.set(prefix, { ws, node });
    return ws;
  }
  closeAll() {
    for (const { ws } of this.map.values()) {
      ws.end();
    }
    this.map.clear();
    this.head = this.tail = null;
  }
}

const streamCache = new LRUStreams(MAX_STREAMS);

// Recursively find all .txt files
function findTxtFiles(dir) {
  let results = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      results = results.concat(findTxtFiles(full));
    } else if (ent.isFile() && ent.name.endsWith('.txt')) {
      results.push(full);
    }
  }
  return results;
}

// Process a .txt file: spawn parser and pipe JSON lines to shards
function processFile(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['parse-and-hash.js', filePath], {
      cwd: process.cwd(),
      env: process.env
    });
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

    proc.stderr.on('data', data => {
      console.error(`[parser stderr] ${data}`);
    });

    rl.on('line', line => {
      try {
        const record = JSON.parse(line);
        const prefix = record.email_hash.slice(0,4);
        const ws = streamCache.get(prefix);
        ws.write(JSON.stringify(record) + '\n');
      } catch (err) {
        console.error('Failed to parse JSON line:', line);
      }
    });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Parser exited with code ${code}`));
    });
  });
}

// Main ingestion flow
(async () => {
  console.log(`==== RUN START: ${new Date().toISOString()} ====`);
  console.log(`Root: ${ROOT}`);
  const files = findTxtFiles(ROOT);
  console.log(`Found ${files.length} .txt files.`);
  for (const fp of files) {
    if (progress[fp] === 'done') continue;
    console.log(`Processing ${fp}`);
    progress[fp] = 'in-progress'; saveProgress();
    try {
      await processFile(fp);
    } catch (err) {
      console.error(`Error processing ${fp}:`, err);
      process.exit(1);
    }
    progress[fp] = 'done'; saveProgress();
  }
  streamCache.closeAll();
  console.log('Compressing shards...');
  spawnSync('bash', ['-c', `gzip -f "${SHARD_DIR}"/*/*.jsonl`], { stdio: 'inherit' });
  console.log(`==== RUN END  : ${new Date().toISOString()} ====`);
})();