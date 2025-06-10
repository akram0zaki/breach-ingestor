# Performance Tuning Guide

This guide covers optimization strategies for the breach-ingestor system to maintain consistent performance when processing multi-terabyte datasets.

## Table of Contents
- [Performance Monitoring](#performance-monitoring)
- [Application Optimizations](#application-optimizations)
- [PostgreSQL Configuration](#postgresql-configuration)
- [Billion-Record Scale Optimization](#billion-record-scale-optimization)
- [System-Level Optimizations](#system-level-optimizations)
- [Hardware Recommendations](#hardware-recommendations)
- [NAS Storage Optimization](#nas-storage-optimization)
- [Troubleshooting Performance Issues](#troubleshooting-performance-issues)

---

## Performance Monitoring

### Built-in Metrics
The ingestion scripts now include automatic performance tracking:

```
[2025-06-10T10:30:45.456Z] Imported 50000 rows from /path/to/file.txt (150 oversized records skipped) | 22.6 min/1M records
```

**Key Metrics:**
- **Records per file**: Total processed records
- **Skipped records**: Data quality indicators  
- **Time per 1M records**: Processing efficiency metric
- **Maintenance cycles**: Automatic database optimization

### Performance Baseline
Target processing speeds:
- **Good**: 20-30 min/1M records
- **Acceptable**: 30-40 min/1M records  
- **Poor**: >40 min/1M records (requires intervention)

---

## Application Optimizations

### 1. Automatic Maintenance (Implemented)
**Location**: `ingest-pg.js`

```javascript
// Runs VACUUM ANALYZE every 5 files
if (++processedSinceLastMaintenance >= 5) {
  await pg.query('VACUUM ANALYZE breaches');
  processedSinceLastMaintenance = 0;
}
```

**Benefits**: Prevents index bloat and maintains query performance

### 2. Node.js Memory Configuration (Implemented)
**Location**: `ecosystem.config.cjs`

```javascript
interpreter_args: '--max-old-space-size=2048'  // 2GB for Pi 5 compatibility
env: {
  UV_THREADPOOL_SIZE: '8',
  NODE_ENV: 'production'
}
```

**Benefits**: 
- Optimized heap memory for Pi 5 (8GB total)
- More threads for I/O operations
- Production environment optimizations

### 3. Environment Variables
**Location**: `.env`

```bash
# Optimize batch sizes for PostgreSQL
PROGRESS_INTERVAL=50000
BATCH_SIZE=50000

# Enable staging for deduplication (optional)
STAGING=false  # Keep disabled for maximum speed
```

---

## PostgreSQL Configuration

### Essential Settings for Bulk Import

#### 1. Memory Settings
```sql
-- Add to postgresql.conf
-- For 8GB Pi 5 with 1GB reserved for OS (7GB available)
shared_buffers = '1GB'                        # PostgreSQL shared memory
maintenance_work_mem = '512MB'                # For VACUUM operations  
work_mem = '64MB'                             # Per operation memory
effective_cache_size = '4GB'                  # Available for caching
```

**Memory Distribution for Pi 5 (8GB total):**
- **OS Reserved**: 1GB
- **PostgreSQL shared_buffers**: 1GB
- **Node.js Application**: 2GB (--max-old-space-size=2048)
- **PostgreSQL work processes**: 1GB
- **System file cache**: 3GB (managed by OS)

**Rationale:**
- Conservative `shared_buffers` (1GB) leaves room for Node.js
- Smaller `work_mem` (64MB) prevents memory exhaustion with multiple connections
- `effective_cache_size` accounts for OS file caching
- Node.js heap reduced to 2GB to coexist with PostgreSQL

#### 2. WAL (Write-Ahead Logging) Settings
```sql
-- Optimize for bulk operations
wal_buffers = '64MB'
checkpoint_completion_target = 0.9
max_wal_size = '2GB'
min_wal_size = '512MB'
```

#### 3. Connection Settings
```sql
-- For high-throughput operations
max_connections = 200
shared_preload_libraries = 'pg_stat_statements'
```

#### 4. Raspberry Pi 5 Specific Settings
```sql
-- Conservative settings for 8GB Pi 5
max_connections = 50                          # Limit concurrent connections
random_page_cost = 4.0                       # Optimize for HDD storage
temp_buffers = 32MB                           # Temporary table memory
max_prepared_transactions = 0                 # Disable 2PC (Two-Phase Commit)
autovacuum_work_mem = 256MB                   # Smaller autovacuum memory
```

#### 5. Network Attached Storage (NAS) Optimizations
```sql
-- Specific settings for PostgreSQL data on Synology NAS with HDDs
random_page_cost = 4.0                       # Higher cost for random I/O on mechanical drives
seq_page_cost = 1.0                          # Sequential reads remain baseline
effective_io_concurrency = 1                 # Conservative for networked HDD storage
wal_sync_method = fdatasync                  # Reliable sync method for network storage
commit_delay = 100000                        # Group commits (100ms) to reduce network round-trips
commit_siblings = 5                          # Minimum concurrent transactions for commit_delay

-- Network connection reliability
tcp_keepalives_idle = 600                    # Keep connections alive (10 min)
tcp_keepalives_interval = 30                 # Check every 30 seconds  
tcp_keepalives_count = 3                     # 3 failed probes before disconnect

-- Write-ahead logging optimized for network storage
wal_buffers = '64MB'                         # Larger WAL buffers for network latency
checkpoint_timeout = '15min'                 # Less frequent checkpoints for network storage
synchronous_commit = off                     # Async commits for better performance (slight risk)
```
#### 6. Temporary Configuration During Import
Run these before starting large imports:

```sql
-- Connect as superuser and run:
SET synchronous_commit = off;               -- Faster commits (slight risk)
SET checkpoint_completion_target = 0.9;     -- Spread checkpoint I/O
SET wal_compression = on;                   -- Reduce WAL size
SET log_min_duration_statement = 60000;    -- Log slow queries (1min+)
```

### Implementation Commands

#### For Linux/macOS:
```bash
# Edit PostgreSQL config
sudo nano /etc/postgresql/15/main/postgresql.conf

# Restart PostgreSQL
sudo systemctl restart postgresql
```

#### For Windows:
```powershell
# Edit config (adjust path for your version)
notepad "C:\Program Files\PostgreSQL\15\data\postgresql.conf"

# Restart service
Restart-Service postgresql-x64-13
```

---

## System-Level Optimizations

### 1. Disk I/O Optimization

#### Linux/macOS:
```bash
# For SSDs - use noop scheduler
echo noop | sudo tee /sys/block/sda/queue/scheduler

# For HDDs - use deadline scheduler  
echo deadline | sudo tee /sys/block/sda/queue/scheduler

# Increase dirty ratio for better write batching
echo 'vm.dirty_ratio = 40' | sudo tee -a /etc/sysctl.conf
echo 'vm.dirty_background_ratio = 10' | sudo tee -a /etc/sysctl.conf
```

#### Windows:
```powershell
# Disable write cache buffer flushing (SSDs only)
fsutil behavior set DisableDeleteNotify 0

# Increase system cache (requires restart)
# This is done through registry - be careful!
```

### 2. Process Priority (Linux/macOS)
```bash
# Run with lower I/O priority to avoid system impact
nice -n 10 ionice -c2 -n7 pm2 start ecosystem.config.cjs
```

### 3. File System Tuning

#### For ext4 (Linux):
```bash
# Mount with optimizations for large files
sudo mount -o remount,noatime,data=writeback /mount/point
```

#### For NTFS (Windows):
```powershell
# Disable last access time updates
fsutil behavior set DisableLastAccess 1
```

---

## Hardware Recommendations

### Minimum Requirements
- **CPU**: 4+ cores, 2.5GHz+
- **RAM**: 8GB+ (16GB recommended)
- **Storage**: SSD for database, HDD acceptable for input files
- **Network**: 1Gbps+ for remote storage

### Optimal Configuration
- **CPU**: 8+ cores, 3.0GHz+
- **RAM**: 32GB+ 
- **Storage**: NVMe SSD for PostgreSQL data directory
- **Network**: 10Gbps for high-throughput scenarios

### Raspberry Pi 5 Specific (8GB)
- **PostgreSQL**: 1GB shared_buffers, 512MB maintenance_work_mem
- **Node.js**: 2GB heap (--max-old-space-size=2048)
- **OS**: 1GB reserved for system operations
- **File Cache**: 3GB available for OS file caching
- **Storage**: Use fastest available storage (USB 3.0 SSD minimum)

### Storage Layout
```
/postgres/data     -> Fast SSD (database files)
/postgres/wal      -> Separate SSD/partition (WAL files)
/input/breaches    -> Large HDD array (source files)
/output/shards     -> Fast SSD (output files)
```

### Raspberry Pi 5 Storage Recommendations

#### Local Storage (Optimal)
```
# Optimal setup for Pi 5
/dev/sda1          -> USB 3.0 SSD for PostgreSQL data and WAL
/dev/sdb1          -> USB 3.0 HDD for input breach files (if large)
/mnt/nas           -> Network storage for archives (if available)

# Mount options for Pi 5 SSD
sudo mount -o noatime,discard /dev/sda1 /postgres
```

#### Network Storage (Synology NAS) Setup
```
# NAS-based PostgreSQL storage setup
/mnt/nas/postgres  -> PostgreSQL data directory on NAS
/mnt/nas/wal       -> WAL files on NAS (same or separate share)

# Mount options for NAS storage (CIFS/SMB)
sudo mount -t cifs //synology-ip/postgres /mnt/nas/postgres \
  -o username=user,password=pass,vers=3.0,cache=strict,noatime

# Alternative: NFS mount (if enabled on Synology)
sudo mount -t nfs synology-ip:/volume1/postgres /mnt/nas/postgres \
  -o vers=4,hard,intr,rsize=32768,wsize=32768
```

**Performance Impact Analysis:**

| Storage Type | Random IOPS | Sequential MB/s | Latency | Best For |
|--------------|-------------|-----------------|---------|----------|
| Local SSD | 50,000+ | 500+ | <1ms | Production workloads |
| USB 3.0 SSD | 20,000+ | 400+ | 1-2ms | Good compromise |
| NAS HDD (1Gb) | 100-200 | 80-120 | 5-15ms | Bulk storage, archives |
| NAS SSD (1Gb) | 500-1000 | 100-120 | 3-8ms | Network-limited |

**Your Setup Considerations:**
- **Network**: 1Gbps = ~120MB/s theoretical max
- **HDD RAID**: Synology RAID1/5/6 affects write performance
- **Network protocols**: SMB3/CIFS vs NFS performance differences
- **Caching**: Synology read/write cache settings

**Pi 5 Storage Notes:**
- Use USB 3.0 SSD for best performance (avoid SD card for database)
- Enable TRIM support with `discard` mount option
- Consider splitting PostgreSQL data and WAL to separate USB devices if possible

---

## Billion-Record Scale Optimization

### PostgreSQL Scale Capabilities

PostgreSQL can absolutely handle billions of records with proper configuration:

- **Maximum table size**: 32 TB
- **Maximum rows**: No theoretical limit (storage dependent)
- **Real-world examples**: Discord (trillion+ messages), Instagram (billion+ photos)
- **Your estimated storage**: 300-500 GB per billion breach records

### Index Strategy for Bulk Loading

#### Performance Impact of Indexes During Bulk Insert

| Operation | With Indexes | Without Indexes | Performance Gain |
|-----------|-------------|----------------|------------------|
| INSERT speed | 100% baseline | 300-500% faster | **3-5x improvement** |
| Memory usage | High (index maintenance) | Low (data only) | **60-80% reduction** |
| Disk I/O | Very high (data + indexes) | Moderate (data only) | **70-90% reduction** |
| WAL generation | 2-3x data size | ~1x data size | **50-70% reduction** |

#### Recommended Strategy for Billion-Record Ingestion

```sql
-- 1. BEFORE starting bulk import (connect as superuser)

-- Drop indexes that slow down inserts
DROP INDEX IF EXISTS idx_unique_breach;

-- Optimize PostgreSQL for bulk loading
SET maintenance_work_mem = '2GB';          -- More memory for operations
SET checkpoint_completion_target = 0.9;    -- Spread checkpoints
SET wal_compression = on;                  -- Reduce WAL size
SET synchronous_commit = off;              -- Async commits (slight risk)
SET log_min_duration_statement = 60000;   -- Log slow queries only

-- Disable autovacuum during bulk load
ALTER TABLE breaches SET (autovacuum_enabled = false);
ALTER TABLE breaches_stage SET (autovacuum_enabled = false);

-- 2. DURING bulk import
-- Your existing ingestion process runs here
-- Expected performance: 15-25 min/1M records (vs 40-60 min/1M with indexes)

-- 3. AFTER bulk import completion
-- Re-enable autovacuum
ALTER TABLE breaches SET (autovacuum_enabled = true);

-- Create indexes using parallel workers (PostgreSQL 11+)
SET max_parallel_maintenance_workers = 4;
SET maintenance_work_mem = '4GB';

-- Create primary key (if not exists)
-- Note: BIGSERIAL automatically creates primary key, but if dropped:
-- ALTER TABLE breaches ADD CONSTRAINT breaches_pkey PRIMARY KEY (id);

-- Create unique constraint index (this is your bottleneck)
CREATE UNIQUE INDEX CONCURRENTLY idx_unique_breach 
ON breaches(email_norm, password, source);

-- Create additional performance indexes
CREATE INDEX CONCURRENTLY idx_breaches_email_norm ON breaches(email_norm);
CREATE INDEX CONCURRENTLY idx_breaches_source ON breaches(source);
CREATE INDEX CONCURRENTLY idx_breaches_hash_type ON breaches(hash_type);

-- Final maintenance
VACUUM ANALYZE breaches;

-- Reset settings to normal
RESET maintenance_work_mem;
RESET checkpoint_completion_target;
RESET wal_compression;
RESET synchronous_commit;
RESET log_min_duration_statement;
```

#### Index Creation Time Estimates (Billion Records)

| Index Type | Creation Time | Storage Size | Notes |
|------------|---------------|--------------|-------|
| Primary Key (id) | 2-4 hours | 40-50 GB | B-tree on BIGSERIAL |
| Unique Constraint | 6-12 hours | 100-150 GB | Composite index (email,password,source) |
| Single Column | 1-3 hours | 30-80 GB | Depends on column cardinality |

#### Optimized Ingestion Configuration

Update your `.env` for billion-record ingestion:

```properties
# Optimized for bulk loading without indexes
STAGING=false                    # Direct insert (faster without unique constraint)
BATCH_SIZE=100000               # Larger batches for better throughput
PROGRESS_INTERVAL=500000        # Less frequent logging
DEBUG=false                     # Reduce log overhead
```

#### Memory Configuration for Billion-Record Scale

```sql
-- PostgreSQL configuration for massive bulk imports
-- Add to postgresql.conf

# Memory settings for Pi 5 during bulk import
shared_buffers = '1GB'                    # PostgreSQL shared memory
maintenance_work_mem = '2GB'              # For index creation
work_mem = '256MB'                        # Larger work memory
effective_cache_size = '4GB'              # Available for caching

# WAL settings for bulk import
wal_buffers = '256MB'                     # Larger WAL buffers
max_wal_size = '4GB'                      # More WAL space
checkpoint_timeout = '30min'              # Less frequent checkpoints
checkpoint_completion_target = 0.9       # Spread checkpoint I/O

# Bulk import optimizations
autovacuum = off                          # Disable during bulk import
fsync = off                               # DANGEROUS: Only for bulk import
synchronous_commit = off                  # Async commits
full_page_writes = off                    # DANGEROUS: Only for bulk import

# Connection settings
max_connections = 25                      # Reduced for bulk operations
```

**⚠️ IMPORTANT SAFETY NOTES:**
- `fsync = off` and `full_page_writes = off` are **DANGEROUS** - only use during bulk import
- Take a backup before starting billion-record ingestion
- Re-enable safety settings after import completion
- Consider using a separate instance for bulk import if possible

---

## NAS Storage Optimization

### Overview
When using network-attached storage (such as Synology NAS) for PostgreSQL data, specific optimizations are required to account for network latency and mechanical drive characteristics.

### 1. Network Storage Setup

#### Synology NAS Configuration
```bash
# Enable required services on Synology
# - File Station
# - SMB/CIFS or NFS
# - (Optional) SSD Cache if available

# Create dedicated volumes/shares for PostgreSQL
# /volume1/postgres/data    -> Main database files
# /volume1/postgres/wal     -> Write-ahead logs (can be same share)
# /volume1/postgres/backup  -> Backup storage
```

#### Pi 5 Mount Configuration
```bash
# CIFS/SMB mounting (recommended for Synology)
sudo mkdir -p /mnt/nas/{postgres,wal,backup}

# Mount with optimized options
sudo mount -t cifs //synology-ip/postgres /mnt/nas/postgres \
  -o username=dbuser,password=dbpass,vers=3.0,cache=strict,noatime,uid=postgres,gid=postgres

# For better performance, use these mount options:
# - vers=3.0: Use SMB 3.0 for better performance
# - cache=strict: Enable read caching
# - noatime: Don't update access times
# - uid/gid=postgres: Proper ownership for PostgreSQL

# Alternative: NFS mounting (if available)
sudo mount -t nfs synology-ip:/volume1/postgres /mnt/nas/postgres \
  -o vers=4,hard,intr,rsize=65536,wsize=65536,timeo=600,retrans=5

# Add to /etc/fstab for persistence
echo "//synology-ip/postgres /mnt/nas/postgres cifs username=dbuser,password=dbpass,vers=3.0,cache=strict,noatime,uid=postgres,gid=postgres 0 0" | sudo tee -a /etc/fstab
```

### 2. PostgreSQL Configuration for NAS

#### Essential NAS-Specific Settings
```sql
-- Add to postgresql.conf for NAS storage

# Storage and I/O settings for mechanical drives over network
random_page_cost = 4.0                       # Higher cost for random I/O on networked HDDs
seq_page_cost = 1.0                          # Sequential reads remain baseline  
effective_io_concurrency = 1                 # Conservative for networked storage

# Network-aware commit settings
commit_delay = 100000                        # Group commits (100ms) to reduce network round-trips
commit_siblings = 5                          # Minimum concurrent transactions for commit_delay
synchronous_commit = off                     # Async commits for network storage

# Network connection reliability
tcp_keepalives_idle = 600                    # Keep connections alive (10 min)
tcp_keepalives_interval = 30                 # Check every 30 seconds
tcp_keepalives_count = 3                     # 3 failed probes before disconnect

# WAL settings optimized for network storage
wal_buffers = '128MB'                        # Larger WAL buffers for network latency
wal_sync_method = fdatasync                  # Reliable sync method for network storage
checkpoint_timeout = '15min'                # Less frequent checkpoints for network storage
checkpoint_completion_target = 0.9          # Spread checkpoint I/O over longer period

# Connection and memory management for Pi 5 + NAS
max_connections = 25                         # Reduced for NAS to prevent connection overhead
shared_buffers = '768MB'                     # Slightly reduced for network storage
work_mem = '32MB'                           # Smaller work_mem to prevent network congestion
maintenance_work_mem = '256MB'               # Reduced maintenance memory for NAS
```

### 3. Performance Expectations

#### Realistic Performance Targets for Pi 5 + Synology NAS
```
Storage Type          | Expected Performance | Network Impact
---------------------|---------------------|----------------
NAS HDD (1Gbps)      | 40-60 min/1M        | High latency
NAS SSD (1Gbps)      | 30-45 min/1M        | Bandwidth limited
NAS HDD + SSD Cache  | 35-50 min/1M        | Cache hit dependent
Hybrid (Local WAL)   | 25-40 min/1M        | Reduced write latency
```

#### Network Bandwidth Utilization
```bash
# Monitor network usage during ingestion
iftop -i eth0                               # Real-time network usage
sar -n DEV 1                               # Network statistics

# Expected patterns:
# - High write traffic during bulk inserts
# - Bursty traffic during VACUUM/maintenance
# - Consistent read traffic for index operations
```

### 4. Optimization Strategies

#### A. Hybrid Storage Approach (Recommended)
```bash
# Use local storage for high-frequency writes, NAS for data
# This significantly improves performance

# Local USB SSD for WAL logs
mkdir -p /postgres/wal
mount /dev/sda1 /postgres/wal

# NAS for main data files
mount //synology/postgres /mnt/nas/postgres

# PostgreSQL configuration
# data_directory = '/mnt/nas/postgres/data'
# wal_log_hints = on
# archive_mode = on
# archive_command = 'cp %p /mnt/nas/postgres/archive/%f'
```

#### B. Synology NAS Optimizations
```bash
# On Synology NAS (via SSH or Control Panel):

# 1. Enable SSD cache if available
# - Go to Storage Manager > SSD Cache
# - Create read-write cache on SSD volume
# - Size: Use all available SSD space

# 2. Optimize RAID settings
# - RAID 1: Best for small datasets, good redundancy
# - RAID 5: Good balance for larger datasets
# - RAID 6: Maximum redundancy, slower writes

# 3. Network optimization
# - Enable SMB3 Multi-Channel if supported
# - Disable unnecessary services (Media indexing, etc.)
# - Set maximum SMB protocol to 3.0

# 4. File system optimization
# - Use ext4 for PostgreSQL volumes
# - Enable noatime mount option
```

#### C. Connection Pooling for NAS
```javascript
// In your application (ingest-pg.js)
// Use connection pooling to reduce network overhead

const pool = new Pool({
  max: 5,                    // Reduced pool size for NAS
  idleTimeoutMillis: 300000, // 5 min idle timeout
  connectionTimeoutMillis: 10000, // 10 sec connection timeout
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});
```

### 5. Monitoring NAS Performance

#### Network Performance Monitoring
```bash
# Continuous monitoring during ingestion
# Run on Pi 5:

# Network bandwidth usage
watch -n 2 'cat /proc/net/dev | grep eth0'

# Network latency to NAS
ping -c 4 synology-ip

# SMB/CIFS connection status
sudo smbstatus --shares

# Mount point performance
iostat -x 2 | grep "mnt-nas"
```

#### PostgreSQL NAS-Specific Monitoring
```sql
-- Monitor network-related PostgreSQL metrics
SELECT 
  application_name,
  client_addr,
  state,
  sent_lsn,
  write_lsn,
  replay_lsn,
  sync_state
FROM pg_stat_replication;

-- Check for network-related waits
SELECT 
  wait_event_type, 
  wait_event, 
  COUNT(*) 
FROM pg_stat_activity 
WHERE wait_event IS NOT NULL 
GROUP BY wait_event_type, wait_event 
ORDER BY count DESC;

-- Monitor checkpoint performance (important for NAS)
SELECT 
  checkpoints_timed,
  checkpoints_req,
  checkpoint_write_time,
  checkpoint_sync_time
FROM pg_stat_bgwriter;
```

### 6. Troubleshooting NAS Issues

#### Common NAS Problems and Solutions

**Problem**: Very slow performance (>80 min/1M records)
```bash
# Solution 1: Check network connectivity
ping -c 10 synology-ip
iperf3 -c synology-ip -t 30    # Test throughput

# Solution 2: Remount with optimized options
sudo umount /mnt/nas/postgres
sudo mount -t cifs //synology-ip/postgres /mnt/nas/postgres \
  -o vers=3.0,cache=strict,noatime,rsize=65536,wsize=65536
```

**Problem**: Connection timeouts or drops
```bash
# Solution: Increase network timeouts
# Add to postgresql.conf:
# tcp_keepalives_idle = 1200
# tcp_keepalives_interval = 60
# tcp_keepalives_count = 5
```

**Problem**: Inconsistent performance
```bash
# Solution: Enable and monitor SSD cache on Synology
# Check cache hit rates in Storage Manager
# Consider using local storage for WAL files
```

#### Emergency Recovery for NAS Issues
```bash
# If NAS becomes unavailable during ingestion:

# 1. Stop ingestion gracefully
touch STOP_INGESTION

# 2. Switch to local storage temporarily
sudo mkdir -p /tmp/postgres_emergency
sudo chown postgres:postgres /tmp/postgres_emergency

# 3. Update postgresql.conf temporarily
# data_directory = '/tmp/postgres_emergency'

# 4. Restore from backup once NAS is available
```

---

## Troubleshooting Performance Issues

### 1. Identify Bottlenecks

#### Monitor Performance Metrics:
```bash
# Watch performance in real-time
pm2 logs breach-ingestor-pg | grep "min/1M records"

# PostgreSQL activity
psql -c "SELECT pid, query, state, query_start FROM pg_stat_activity WHERE state = 'active';"
```

#### System Resource Usage:
```bash
# Linux/macOS
top -p $(pgrep -f ingest-pg)
iotop -p $(pgrep -f ingest-pg)

# Windows
Get-Process node | Sort-Object CPU -Descending
```

### 2. Common Issues & Solutions

#### Slow Performance (>40 min/1M records)
**Symptoms**: Processing time increases significantly over time

**Solutions**:
1. Run manual maintenance:
   ```sql
   VACUUM ANALYZE breaches;
   REINDEX INDEX CONCURRENTLY idx_unique_breach;
   ```

2. Check for lock contention:
   ```sql
   SELECT * FROM pg_locks WHERE NOT granted;
   ```

3. Restart with staging mode temporarily:
   ```bash
   echo "STAGING=true" >> .env
   pm2 restart breach-ingestor-pg
   ```

#### Memory Issues
**Symptoms**: Out of memory errors, process crashes

**Solutions**:
1. Increase Node.js heap (Pi 5 limit):
   ```javascript
   interpreter_args: '--max-old-space-size=2048'  // Max for 8GB Pi
   ```

2. Reduce batch sizes:
   ```bash
   PROGRESS_INTERVAL=25000
   ```

3. Check for memory leaks:
   ```bash
   # Pi 5 memory monitoring
   free -m
   sudo systemctl status postgresql
   pm2 monit
   ```

#### Pi 5 Thermal Throttling
**Symptoms**: Sudden performance drops, high CPU temperature

**Solutions**:
1. Monitor temperature:
   ```bash
   vcgencmd measure_temp
   # Should stay below 80°C under load
   ```

2. Improve cooling:
   ```bash
   # Check throttling status
   vcgencmd get_throttled
   # 0x0 = no throttling, anything else = throttled
   ```

3. Reduce load if overheating:
   ```bash
   # Lower process priority
   nice -n 15 pm2 restart breach-ingestor-pg
   ```

#### NAS Storage Performance Issues
**Symptoms**: Very slow ingestion (>60 min/1M records), network timeouts

**Solutions**:
1. Check network connectivity:
   ```bash
   # Test network speed to NAS
   iperf3 -c your-nas-ip
   
   # Check mount status
   mount | grep nas
   df -h /mnt/nas
   ```

2. Optimize NAS settings:
   ```bash
   # Synology NAS optimizations
   # Enable SSD cache if available
   # Set appropriate RAID write policy
   # Disable unnecessary services
   ```

3. PostgreSQL NAS-specific tuning:
   ```sql
   -- Increase commit delay for network storage
   SET commit_delay = 200000;  -- 200ms for slow networks
   
   -- Reduce checkpoint frequency
   SET checkpoint_timeout = '20min';
   
   -- Use larger WAL buffers
   SET wal_buffers = '128MB';
   ```

4. Consider hybrid approach:
   ```bash
   # Use local storage for WAL, NAS for data
   # This reduces write latency significantly
   ```

#### Disk Space Issues
**Symptoms**: No space left errors, slow I/O

**Solutions**:
1. Enable WAL archiving:
   ```sql
   -- PostgreSQL config
   archive_mode = on
   archive_command = 'cp %p /archive/%f'
   ```

2. Monitor disk usage:
   ```bash
   # Linux/macOS
   df -h /postgres/data
   du -sh /postgres/data/pg_wal

   # Windows  
   Get-Volume
   ```

### 3. Performance Recovery Procedures

#### If Performance Degrades Severely:
1. **Stop ingestion gracefully**:
   ```bash
   # Create stop file
   touch STOP_INGESTION
   ```

2. **Run maintenance**:
   ```sql
   VACUUM FULL ANALYZE breaches;  -- Takes time but reclaims space
   REINDEX DATABASE breachdb;     -- Rebuilds all indexes
   ```

3. **Restart with optimized settings**:
   ```bash
   # Temporary performance mode
   export STAGING=true
   export PROGRESS_INTERVAL=100000
   pm2 restart breach-ingestor-pg
   ```

---

## Monitoring Commands

### Real-time Performance Monitoring
```bash
# Watch processing speed
tail -f ~/.pm2/logs/breach-ingestor-pg-out.log | grep "min/1M records"

# PostgreSQL performance
psql -c "SELECT schemaname,tablename,n_live_tup,n_dead_tup FROM pg_stat_user_tables WHERE tablename='breaches';"

# System resources (Pi optimized)
watch -n 5 'free -m && iostat -x 1 1'

# Pi 5 specific monitoring
vcgencmd measure_temp                         # CPU temperature
vcgencmd get_throttled                        # Throttling status
sudo cat /sys/class/thermal/thermal_zone0/temp # Detailed temp
```

### Performance Alerts
Set up monitoring for:
- Processing time >45 min/1M records
- Memory usage >80% (`free -m`)
- Disk space <10% free (`df -h`)
- PostgreSQL connection count >40 (Pi 5 limit)
- CPU temperature >75°C (`vcgencmd measure_temp`)
- Thermal throttling detected (`vcgencmd get_throttled != 0x0`)

---

## Conclusion

Following this guide should maintain consistent performance throughout large-scale ingestion operations. The key is proactive monitoring and regular maintenance to prevent the exponential degradation seen in large database operations.

**Remember**: Performance tuning is iterative. Monitor the metrics, adjust settings, and re-evaluate based on your specific hardware and dataset characteristics.
