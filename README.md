# AntiPublic Prefix-Sharded Ingestion Service

A resilient, prefix-sharded ingestion pipeline for large static breach dumps, optimized for low-resource environments (e.g., Raspberry Pi + NAS). It:

- **HMAC-hashes** and normalizes emails for privacy  
- **Supports** colon (`:`), semicolon (`;`), and whitespace delimiters  
- **Shards** records into 256 subdirectories by the first two hex characters of the email hash  
- **Logs** files with entries containing more than two fields to `multi_field_files.log` for manual review  
- Uses an **LRU stream cache** to cap open file descriptors (`MAX_STREAMS`)  
- Is **resumable** and **crash-resilient** via per-file progress tracking  
- Generates compressed `*.jsonl.gz` files for **O(1)** lookups  

---

## Architecture

```mermaid
flowchart TD
  A[Discover .txt Files] --> B[orchestrator.js]
  B --> C{Progress Tracker (ingest-progress.json)}
  B --> D{Spawn parse-and-hash.js}
  D --> E[Normalize & HMAC-SHA256(email)]
  E --> F[Detect delimiters, parse fields]
  F --> G[Emit JSON record]
  G --> H{LRUStreams.get(prefix)}
  H --> I[Write JSONL to `shard_dir/xx/xxxx.jsonl`]
  B --> J[Close all streams]
  J --> K[Compress shards: gzip `shard_dir/xx/*.jsonl`]
```

---

## Components

- **`orchestrator.js`**  
- **`parse-and-hash.js`**  
- **`package.json`**  
- **`.env`**  
- **`ingest-progress.json`**  
- **`multi_field_files.log`**  
- **`ecosystem.config.cjs`** (optional)  
- **`.gitignore`**

---

## Prerequisites

- **Node.js ≥14** and **npm**  
- Read/write access to `INPUT_DIR` and `SHARD_DIR`  
- **PM2** for process management (optional but recommended)  

---

## Installation

```bash
git clone <repo-url> .
npm install
```

### Installing PM2

To install PM2 globally:

```bash
npm install -g pm2
```

Verify installation:

```bash
pm2 -v
```

---

## Configuration

1. Create a `.env` file in the project root:

   ```dotenv
   EMAIL_HASH_KEY=<hex-encoded 32-byte key>
   INPUT_DIR=/mnt/Torrents/WDHome/breaches
   SHARD_DIR=/mnt/Torrents/WDHome/data/shards
   MAX_STREAMS=100
   ```
2. Ensure `SHARD_DIR` exists and is writable:

   ```bash
   mkdir -p "$SHARD_DIR"
   sudo chown -R $(whoami):$(whoami) "$SHARD_DIR"
   ```

3. (Optional) Customize `ecosystem.config.cjs` for PM2 (Unix/Linux ONLY):

   ```js
   module.exports = {
     apps: [{
       name: 'ingest-orchestrator',
       script: 'orchestrator.js',
       interpreter: 'bash',
       interpreter_args: '-c "nice -n 10 ionice -c2 -n7 node orchestrator.js"',
       log_date_format: 'YYYY-MM-DD HH:mm Z',
       autorestart: true,
       watch: false
     }]
   };
   ```
4. (Optional) Customize `ecosystem.config.cjs` for PM2 (Windows):
 ```js
  module.exports = {
    apps: [{
      name: 'ingest-orchestrator',
      script: 'orchestrator.js',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }]
  };
'''

---

## Running Ingestion

### With npm

```bash
npm run ingest
```

### With PM2

```bash
npm start            # Starts via ecosystem.config.cjs
pm2 save             # Save process list
pm2 startup systemd  # Generate startup script
```

---

## Verifying Status & Logs

- **List processes**: `pm2 list` or `npm run status`  
- **Realtime logs**: `pm2 logs ingest-orchestrator` or `npm run logs`  
- **Error-only logs**:

  ```bash
  tail -f ~/.pm2/logs/ingest-orchestrator-error.log
  ```

- **Progress**: View `ingest-progress.json`  
- **Multi-field files**: Check `multi_field_files.log`  
- Flush logs without deleting them: pm2 flush ingest-orchestrator
- Flush logs manually:
cd ~/.pm2/logs/
ls ingest-orchestrator*
then truncate the files:
: > ~/.pm2/logs/ingest-orchestrator-out.log
: > ~/.pm2/logs/ingest-orchestrator-error.log

---

## Troubleshooting

### EMFILE: too many open files

- Node.js ran into the OS limit for maximum simultaneously open file descriptors. This is a hard crash. The error is unhandled and causes Node.js to terminate your process. Any pending writes to shards at the moment of crash may be lost unless they were flushed to disk.

- Cause? Your ingestion pipeline keeps many shard files open at once (e.g. MAX_STREAMS = 256), and with other open descriptors (input file, logs, stdout, etc.), it eventually exceeds your OS limit — often 1024 or 4096 on Raspberry Pi/Linux.

- Fix:
  - Lower MAX_STREAMS in orchestrator.js (or .env), use a small value like 64. This reduces how many .jsonl files are open concurrently. Node will reuse handles via the LRU cache.
  - You can also increase the OS limit temporarily until the next reboot. Execute "ulimit -n 4096"
  - To permenantely increase the OS limit. Edit "sudo nano /etc/security/limits.conf" and add:
      pi soft nofile 4096
      pi hard nofile 8192
  - To ensure PAM respects it edit "sudo nano /etc/pam.d/common-session" and add:
      session required pam_limits.so




## Robustness & Resilience

- **Resumable**: Skips files marked `done`  
- **Crash-resistant**: Progress saved after every file  
- **FD control**: LRUStreams limits open descriptors  
- **Flexible parsing**: Supports `:`, `;`, and whitespace delimiters  
- **Additive schema**: Consumers handle missing/new fields gracefully  

---

## Troubleshooting

- **Permission issues**: Check mount options, ownership, `uid`/`gid` in `/etc/fstab`.  
- **Malformed progress**: Reset `ingest-progress.json` to `{}` if corrupted.  
- **PM2 startup**: If `pm2 startup` prompts, copy the printed command and run with `sudo`.  

---

## License

MIT © Your Name
