# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-06-10

### Added
- **Performance Monitoring**: Enhanced `ingest-pg.js` with automatic performance metrics:
  - Time per 1 million records tracking
  - Processing time calculation for each file
  - Performance degradation detection
  - Real-time metrics in log output format: `X.X min/1M records`

- **Automatic Database Maintenance**: Periodic optimization to prevent performance degradation:
  - VACUUM ANALYZE runs every 5 processed files
  - Configurable maintenance intervals
  - Automatic cleanup of table bloat and index optimization

- **Performance Tuning Guide**: Comprehensive documentation covering:
  - Application-level optimizations
  - PostgreSQL configuration for bulk imports
  - System-level tuning recommendations
  - Hardware requirements and layout suggestions
  - Troubleshooting guide for performance issues

### Changed
- **Ecosystem Configuration**: Enhanced PM2 settings for better performance:
  - Increased Node.js heap size to 4GB (`--max-old-space-size=4096`)
  - Added UV_THREADPOOL_SIZE=8 for better I/O performance
  - Production environment variables

- **Logging Enhancement**: More detailed performance information:
  - Processing time per file with millisecond precision
  - Records per million calculation
  - Maintenance cycle logging
  - Performance trend visibility

### Performance Improvements
- **Database Optimization**: Automatic VACUUM ANALYZE prevents index bloat
- **Memory Management**: Optimized Node.js memory allocation
- **I/O Performance**: Enhanced thread pool size for better throughput
- **Monitoring**: Real-time performance degradation detection

### Documentation
- **PERFORMANCE-TUNING.md**: Complete guide covering:
  - Performance monitoring and baseline metrics
  - PostgreSQL configuration for bulk operations
  - System-level optimizations (Linux/macOS/Windows)
  - Hardware recommendations
  - Troubleshooting procedures

## [1.0.0] - 2025-06-09

### Added
- **Comprehensive Documentation**: Complete rewrite of README.md with detailed documentation covering:
  - Architecture overview with data flow diagrams
  - Setup and configuration instructions
  - Usage examples for all components
  - Performance tuning guidelines
  - Security considerations and troubleshooting
  - Data schema documentation

- **Hybrid Safe Shutdown Mechanism**: Enhanced `ingest-fs.js` with robust shutdown capabilities:
  - SIGTERM and SIGINT signal handlers for graceful process termination
  - Cross-platform stop file detection (`STOP_INGESTION` file)
  - Integrated stop checks in worker loop before processing each file
  - Automatic stop file cleanup on shutdown
  - Enhanced logging for shutdown events

- **Production-Ready Process Management**: 
  - PM2 configuration for both filesystem and PostgreSQL ingestion modes
  - npm scripts for easy process lifecycle management
  - Background process support with proper logging

### Changed
- **Environment Configuration**: Updated `.gitignore` to use Node.js best practices:
  - Removed Python-specific patterns (\_\_pycache\_\_, *.py[cod], .Python, etc.)
  - Added comprehensive Node.js patterns (node_modules/, npm-debug.log*, etc.)
  - Maintained essential environment file exclusions (.env)
  - Preserved IDE and custom project patterns

- **Documentation Structure**: 
  - Reorganized README.md with clear sections for different user personas
  - Added practical examples and troubleshooting scenarios
  - Included performance benchmarks and optimization recommendations

### Technical Details

#### Core Components
- **ingest-fs.js** (338 lines): Filesystem sharding with HMAC email hashing, LRU stream cache, and batch processing
- **ingest-pg.js** (298 lines): PostgreSQL ingestion using bulk COPY streams with hash detection and staging support
- **merge-shards.js** (114 lines): Merges shard files from multiple directories with progress tracking
- **scrub-emails.js** (69 lines): Removes cleartext emails from shards for privacy compliance
- **compress-shards.js** (51 lines): Compresses .jsonl files to .jsonl.gz format for storage optimization
- **retro-dedupe.js** (102 lines): Retroactive deduplication of existing shards
- **test-hash.js** (42 lines): Test utility for email normalization and hashing validation

#### Performance Characteristics
- **Filesystem Mode**: 50,000-100,000 records/second with configurable batch sizes
- **PostgreSQL Mode**: 3-5x faster than raw INSERT approach using JavaScript preprocessing + COPY streams
- **Memory Management**: LRU cache for file streams with configurable limits
- **Resumability**: Automatic progress tracking and resume capability for interrupted operations

#### Security Features
- HMAC-SHA256 email hashing with configurable secrets
- Environment variable protection via .gitignore
- Safe email scrubbing for privacy compliance
- Secure database connection handling

### Dependencies
- **dotenv**: ^16.0.0 - Environment variable management
- **Node.js**: >=14 - Runtime requirement

### Process Management
- **PM2**: Production process management with ecosystem configuration
- **Scripts**: Comprehensive npm scripts for lifecycle management
  - `npm run ingest` - Start filesystem ingestion
  - `npm run start` - Start with PM2 process manager
  - `npm run ingestpg` - Start PostgreSQL ingestion
  - `npm run status` - Check process status

### File Structure
```
breach-ingestor/
├── ingest-fs.js          # Main filesystem ingestion script
├── ingest-pg.js          # PostgreSQL ingestion script
├── merge-shards.js       # Shard merging utility
├── scrub-emails.js       # Email privacy scrubber
├── compress-shards.js    # Compression utility
├── retro-dedupe.js       # Retroactive deduplication
├── test-hash.js          # Hash testing utility
├── ecosystem.config.cjs  # PM2 configuration
├── package.json          # Project configuration
├── .env.example          # Environment template
├── .gitignore            # Git exclusion patterns
├── README.md             # Comprehensive documentation
└── CHANGELOG.md          # This file
```

### Breaking Changes
None. This is the initial stable release.

### Migration Guide
This is the first documented release. For users upgrading from undocumented versions:
1. Review the new `.env.example` for required environment variables
2. Use the new npm scripts for process management
3. Refer to the updated README.md for configuration options

### Known Issues
None at this time.

### Contributors
- Project maintainer and development team

---

## Future Releases

### Planned Features
- Enhanced monitoring and metrics collection
- Additional database backend support
- Improved error recovery mechanisms
- Performance optimization tools
- Extended utility scripts

---

*For more information about this project, see the [README.md](README.md) file.*
