# Breach Data Ingestor

A comprehensive Node.js toolkit for processing and managing large breach datasets with email/password pairs. Supports both filesystem-based sharding and PostgreSQL database ingestion, designed to handle multi-terabyte datasets efficiently.

## Components

### Main Ingestion Systems

- **`ingest-fs.js`** - Filesystem-based sharding with HMAC email hashing
- **`ingest-pg.js`** - PostgreSQL database ingestion with hash type detection

### Utility Scripts

- **`merge-shards.js`** - Merge shard files from multiple directories
- **`scrub-emails.js`** - Remove cleartext emails from shards for privacy
- **`compress-shards.js`** - Compress .jsonl files to .jsonl.gz format
- **`retro-dedupe.js`** - Retroactive deduplication of existing shards
- **`test-hash.js`** - Test email normalization and hashing

## Features

### Core Features
- **Privacy-First**: Emails hashed using HMAC-SHA256 with secret key
- **Flexible Input**: Multiple delimiters (colon, semicolon, whitespace) and field orders
- **Dual Storage**: Filesystem sharding or PostgreSQL database storage
- **Hash Detection**: Automatic detection of MD5, SHA1, and bcrypt password hashes
- **Resilient Processing**: Progress tracking and crash recovery support
- **Safe Operations**: Graceful shutdown with signal handling

### Filesystem Sharding
- **Efficient Distribution**: 256 subdirectories (00-ff) based on email hash prefix
- **Stream Processing**: Low memory footprint with LRU cache for file descriptors
- **Batch Processing**: Configurable batch sizes and flush intervals

### PostgreSQL Ingestion
- **Staging Support**: Optional staging table for deduplication
- **Bulk Loading**: PostgreSQL COPY streams for high-performance insertion
- **Conflict Handling**: Configurable duplicate handling strategies

---

## Architecture

### Filesystem Sharding Flow

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

```
Breach Files → Email Normalization → HMAC-SHA256 → Prefix Extraction → Shard Assignment → JSONL Output
```

### PostgreSQL Ingestion Flow
```
Breach Files → Format Detection → Hash Type Detection → Bulk COPY → Optional Staging → Main Table
```

---

## Prerequisites

- **Node.js ≥14** and **npm**
- **PostgreSQL** (for database ingestion mode)
- Read/write access to input and output directories
- **PM2** for process management (optional but recommended)

---

## Installation

```bash
git clone https://github.com/akram0zaki/breach-ingestor .
npm install
```

### Installing PM2 (Optional)

```bash
npm install -g pm2
pm2 -v  # Verify installation
```

---

## Configuration

Create a `.env` file in the project root based on `.env.example`:

```dotenv
# Required: 32-byte hex key for email hashing
EMAIL_HASH_KEY=<your-hex-encoded-32-byte-key>

# Input/Output Directories
INPUT_DIR=/mnt/nas/breaches
SHARD_DIR=/mnt/nas/data/shards

# Filesystem Sharding Settings
PROGRESS_FILE_NAME=ingest-progress.json
MAX_STREAMS=1024
BATCH_SIZE=50000
BATCH_INTERVAL_MS=20000
CONCURRENCY=1

# PostgreSQL Settings
PG_USER=pi
PG_PASSWORD=<your-password>
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=breachdb
STAGING=false
DEBUG=true
PROGRESS_INTERVAL=100000
SKIPPED_LOG=skipped.log
```

### Directory Setup

```bash
# Create required directories
mkdir -p "$SHARD_DIR"
sudo chown -R $(whoami):$(whoami) "$SHARD_DIR"
```

---

## Usage

### Filesystem Sharding

```bash
# Direct execution
node ingest-fs.js

# Via npm scripts
npm run ingest    # Start ingestion
npm run start     # Start with PM2
npm run stop      # Stop PM2 process
npm run status    # Check PM2 status
npm run logs      # View PM2 logs
```

### PostgreSQL Ingestion

```bash
# Direct execution
node ingest-pg.js

# Via npm scripts
npm run ingestpg  # Start PostgreSQL ingestion
npm run startpg   # Start with PM2
npm run stoppg    # Stop PM2 process
```

### Utility Scripts

#### Merge Shards
Combine shard files from multiple directories:
```bash
SHARD_DIRS=/path/to/base,/path/to/other1,/path/to/other2 node merge-shards.js
```

#### Scrub Emails
Remove cleartext email fields for privacy:
```bash
SHARD_DIR=/path/to/shards node scrub-emails.js
```

#### Compress Shards
Convert .jsonl files to .jsonl.gz:
```bash
SHARD_DIR=/path/to/shards node compress-shards.js
```

#### Deduplicate Shards
Remove duplicate entries retroactively:
```bash
SHARD_DIR=/path/to/shards node retro-dedupe.js
```

#### Test Email Hashing
Test email normalization and hashing:
```bash
node test-hash.js example@domain.com
```

---

## Data Processing

### Email Normalization
1. Trim whitespace and convert to lowercase
2. Remove leading non-alphanumeric characters
3. Strip plus-tags from local part (before @)
4. Generate HMAC-SHA256 hash using secret key

### Shard Assignment (Filesystem)
- Uses first 2 hex characters of email hash as subdirectory (00-ff)
- Creates 256 balanced subdirectories for efficient distribution
- Each shard contains JSONL records with email_hash, password, source

### Hash Type Detection (PostgreSQL)
- **MD5**: 32 hex characters
- **SHA1**: 40 hex characters  
- **bcrypt**: Starts with $2a$, $2b$, or $2y$
- **plaintext**: Everything else

### File Format Support
- **Input**: .txt files with various delimiters (`:`, `;`, whitespace)
- **Output**: .jsonl or .jsonl.gz files with JSON records per line

---

## Monitoring & Management

### Progress Tracking
- **Filesystem**: `ingest-progress.json` tracks processed files
- **PostgreSQL**: `ingest-progress.json` tracks completed files
- **Utility scripts**: Each maintains its own progress file

### Graceful Shutdown
- **Unix/Linux**: Send SIGTERM or SIGINT (Ctrl+C)
- **Windows/Cross-platform**: Create `STOP_INGESTION` file in script directory
- Process completes current file before stopping

### PM2 Management
```bash
pm2 start ecosystem.config.cjs --only breach-ingestor
pm2 logs breach-ingestor  # View logs
pm2 restart breach-ingestor
pm2 stop breach-ingestor
pm2 delete breach-ingestor
```

---

## Troubleshooting

### Common Issues

#### EMFILE: too many open files
**Cause**: Exceeded OS file descriptor limit

**Solutions**:
- Reduce `MAX_STREAMS` in .env (try 64-256)
- Increase OS limit: `ulimit -n 4096`
- Permanent fix (Linux): Edit `/etc/security/limits.conf`:
  ```
  pi soft nofile 4096
  pi hard nofile 8192
  ```

#### PostgreSQL Connection Errors
**Cause**: Database connection issues

**Solutions**:
- Verify PostgreSQL is running
- Check connection string in .env
- Ensure database exists and user has permissions
- Test connection: `psql -h localhost -U pi -d breachdb`

#### Memory Issues
**Cause**: Large batch sizes or high concurrency

**Solutions**:
- Reduce `BATCH_SIZE` and `CONCURRENCY`
- Increase `BATCH_INTERVAL_MS` for more frequent flushing
- Monitor memory usage with `top` or `htop`

#### Permission Errors
**Cause**: Insufficient directory permissions

**Solutions**:
- Check mount options for network shares
- Verify ownership: `chown -R $(whoami) /path/to/directories`
- For Windows network shares: Use persistent `net use` connections

#### Corrupted Progress Files
**Solutions**:
- Reset filesystem progress: `echo '{}' > ingest-progress.json`
- Reset PostgreSQL progress: `echo '[]' > ingest-progress.json`
- Backup progress files before major operations

### Debugging

Enable debug logging:
```bash
DEBUG=true node ingest-fs.js
DEBUG=true node ingest-pg.js
```

Check skipped files:
```bash
cat skipped.log  # View files that couldn't be processed
```

---

## Performance Tuning

### Filesystem Sharding
- **MAX_STREAMS**: Balance between performance and file descriptors (64-1024)
- **BATCH_SIZE**: Larger batches = better I/O performance but more memory (10000-100000)
- **BATCH_INTERVAL_MS**: Frequent flushing prevents data loss (5000-30000ms)
- **CONCURRENCY**: Multiple workers for CPU-bound tasks (1-4)

### PostgreSQL Ingestion
- **PROGRESS_INTERVAL**: Log frequency for progress updates (1000-100000)
- **STAGING**: Enable for deduplication, disable for speed
- **Connection pooling**: Use connection pooling for high-throughput scenarios

### System-Level
- **I/O scheduling**: Use `ionice -c2 -n7` for background processing
- **Process priority**: Use `nice -n 10` to lower CPU priority
- **Disk optimization**: Use SSDs for shard directories when possible

---

## Security Considerations

- **Email hashing**: Use a strong, unique 32-byte key for `EMAIL_HASH_KEY`
- **Database security**: Use strong passwords and limit database permissions
- **Network shares**: Use encrypted connections for remote storage
- **File permissions**: Restrict access to data directories and .env files
- **Data scrubbing**: Use `scrub-emails.js` to remove cleartext emails

---

## Data Schema

### Filesystem Shard Record
```json
{
  "email_hash": "a1b2c3d4...",
  "password": "secret123",
  "source": "/path/to/breach.txt"
}
```

### PostgreSQL Table Schema
```sql
CREATE TABLE breaches (
  id BIGSERIAL PRIMARY KEY,
  email_norm TEXT NOT NULL,
  raw_email TEXT NOT NULL,
  password TEXT NOT NULL,
  is_hash BOOLEAN NOT NULL,
  hash_type TEXT NOT NULL,
  source TEXT NOT NULL
);
```

---

## License

MIT © Akram Zaki
