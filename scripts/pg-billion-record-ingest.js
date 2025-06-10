#!/usr/bin/env node

/**
 * Optimized Billion-Record Ingestion Script
 * 
 * This script optimizes PostgreSQL for massive bulk imports by:
 * 1. Dropping indexes before import
 * 2. Configuring optimal bulk import settings
 * 3. Running the standard ingestion process
 * 4. Recreating indexes after completion
 * 
 * Usage:
 *   node billion-record-ingest.js
 * 
 * Prerequisites:
 *   - PostgreSQL superuser access
 *   - Sufficient disk space (3-5x final data size during index creation)
 *   - Large maintenance_work_mem configuration
 */

const { Client } = require('pg');
const fs = require('fs');
const { spawn } = require('child_process');

// Configuration
const PG_SUPERUSER_CONN = process.env.PG_SUPERUSER_CONN || 'postgres://postgres@localhost/breachdb';
const BACKUP_INDEXES = true; // Save index definitions before dropping
const PARALLEL_WORKERS = Math.min(4, require('os').cpus().length);

// Logging
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const errorLog = (...args) => console.error(`[${new Date().toISOString()}] ERROR:`, ...args);

// Index definitions to recreate after import
const INDEX_DEFINITIONS = [
  {
    name: 'idx_unique_breach',
    sql: 'CREATE UNIQUE INDEX CONCURRENTLY idx_unique_breach ON breaches(email_norm, password, source)',
    priority: 1 // Create unique constraint first
  },
  {
    name: 'idx_breaches_email_norm',
    sql: 'CREATE INDEX CONCURRENTLY idx_breaches_email_norm ON breaches(email_norm)',
    priority: 2
  },
  {
    name: 'idx_breaches_source',
    sql: 'CREATE INDEX CONCURRENTLY idx_breaches_source ON breaches(source)',
    priority: 3
  },
  {
    name: 'idx_breaches_hash_type',
    sql: 'CREATE INDEX CONCURRENTLY idx_breaches_hash_type ON breaches(hash_type)',
    priority: 4
  }
];

async function executePgCommand(client, sql, description) {
  try {
    log(`Executing: ${description}`);
    await client.query(sql);
    log(`✓ Completed: ${description}`);
  } catch (error) {
    errorLog(`Failed: ${description} - ${error.message}`);
    throw error;
  }
}

async function backupIndexDefinitions(client) {
  if (!BACKUP_INDEXES) return;
  
  try {
    const result = await client.query(`
      SELECT 
        indexname as name,
        indexdef as definition
      FROM pg_indexes 
      WHERE tablename = 'breaches' 
        AND indexname != 'breaches_pkey'
    `);
    
    const backup = {
      timestamp: new Date().toISOString(),
      indexes: result.rows
    };
    
    fs.writeFileSync('index-backup.json', JSON.stringify(backup, null, 2));
    log(`✓ Backed up ${result.rows.length} index definitions to index-backup.json`);
  } catch (error) {
    errorLog(`Failed to backup indexes: ${error.message}`);
  }
}

async function dropIndexes(client) {
  log('=== DROPPING INDEXES FOR BULK IMPORT ===');
  
  // Backup existing indexes first
  await backupIndexDefinitions(client);
  
  // Get list of indexes to drop (excluding primary key)
  const result = await client.query(`
    SELECT indexname 
    FROM pg_indexes 
    WHERE tablename = 'breaches' 
      AND indexname != 'breaches_pkey'
  `);
  
  for (const row of result.rows) {
    await executePgCommand(
      client,
      `DROP INDEX IF EXISTS ${row.indexname}`,
      `Dropping index ${row.indexname}`
    );
  }
  
  log(`✓ Dropped ${result.rows.length} indexes`);
}

async function optimizeForBulkImport(client) {
  log('=== OPTIMIZING POSTGRESQL FOR BULK IMPORT ===');
  
  const optimizations = [
    // Memory optimizations
    "SET maintenance_work_mem = '2GB'",
    "SET work_mem = '256MB'",
    
    // WAL optimizations
    "SET wal_compression = on",
    "SET checkpoint_completion_target = 0.9",
    "SET checkpoint_timeout = '30min'",
    
    // Safety optimizations (use with caution)
    "SET synchronous_commit = off",
    "SET full_page_writes = off",  // DANGEROUS: Only for bulk import
    
    // Disable autovacuum during import
    "ALTER TABLE breaches SET (autovacuum_enabled = false)",
    "ALTER TABLE breaches_stage SET (autovacuum_enabled = false)",
    
    // Logging
    "SET log_min_duration_statement = 60000"
  ];
  
  for (const sql of optimizations) {
    await executePgCommand(client, sql, sql);
  }
  
  log('✓ PostgreSQL optimized for bulk import');
  log('⚠️  WARNING: Safety features disabled - do not use for production queries!');
}

async function runIngestion() {
  log('=== STARTING BULK INGESTION PROCESS ===');
  
  return new Promise((resolve, reject) => {
    // Update .env for optimized bulk import
    const originalEnv = fs.readFileSync('.env', 'utf8');
    const optimizedEnv = originalEnv
      .replace(/STAGING=.*/g, 'STAGING=false')
      .replace(/BATCH_SIZE=.*/g, 'BATCH_SIZE=100000')
      .replace(/PROGRESS_INTERVAL=.*/g, 'PROGRESS_INTERVAL=500000')
      .replace(/DEBUG=.*/g, 'DEBUG=false');
    
    fs.writeFileSync('.env.bulk', optimizedEnv);
    
    // Spawn ingestion process with optimized environment
    const child = spawn('node', ['ingest-pg.js'], {
      stdio: 'inherit',
      env: { ...process.env, ENV_FILE: '.env.bulk' }
    });
    
    child.on('close', (code) => {
      // Restore original .env
      fs.unlinkSync('.env.bulk');
      
      if (code === 0) {
        log('✓ Bulk ingestion completed successfully');
        resolve();
      } else {
        errorLog(`Ingestion failed with exit code ${code}`);
        reject(new Error(`Ingestion process failed`));
      }
    });
    
    child.on('error', (error) => {
      errorLog(`Failed to start ingestion process: ${error.message}`);
      reject(error);
    });
  });
}

async function recreateIndexes(client) {
  log('=== RECREATING INDEXES ===');
  
  // Configure for index creation
  await executePgCommand(client, `SET max_parallel_maintenance_workers = ${PARALLEL_WORKERS}`, 'Setting parallel workers');
  await executePgCommand(client, "SET maintenance_work_mem = '4GB'", 'Setting maintenance memory');
  
  // Sort indexes by priority
  const sortedIndexes = INDEX_DEFINITIONS.sort((a, b) => a.priority - b.priority);
  
  for (const index of sortedIndexes) {
    const startTime = Date.now();
    
    try {
      await executePgCommand(client, index.sql, `Creating index ${index.name}`);
      
      const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      log(`✓ Index ${index.name} created in ${duration} minutes`);
    } catch (error) {
      errorLog(`Failed to create index ${index.name}: ${error.message}`);
      // Continue with other indexes
    }
  }
}

async function restoreNormalSettings(client) {
  log('=== RESTORING NORMAL POSTGRESQL SETTINGS ===');
  
  const restorations = [
    // Re-enable safety features
    "SET synchronous_commit = on",
    "SET full_page_writes = on",
    
    // Re-enable autovacuum
    "ALTER TABLE breaches SET (autovacuum_enabled = true)",
    "ALTER TABLE breaches_stage SET (autovacuum_enabled = true)",
    
    // Reset memory settings
    "RESET maintenance_work_mem",
    "RESET work_mem",
    "RESET max_parallel_maintenance_workers",
    
    // Reset WAL settings
    "RESET wal_compression",
    "RESET checkpoint_completion_target", 
    "RESET checkpoint_timeout",
    "RESET log_min_duration_statement"
  ];
  
  for (const sql of restorations) {
    await executePgCommand(client, sql, sql);
  }
  
  // Final maintenance
  await executePgCommand(client, 'VACUUM ANALYZE breaches', 'Final vacuum analyze');
  
  log('✓ Normal PostgreSQL settings restored');
}

async function main() {
  const client = new Client({ connectionString: PG_SUPERUSER_CONN });
  
  try {
    await client.connect();
    log('✓ Connected to PostgreSQL as superuser');
    
    // Pre-ingestion setup
    await dropIndexes(client);
    await optimizeForBulkImport(client);
    
    // Run the actual ingestion
    await runIngestion();
    
    // Post-ingestion cleanup
    await recreateIndexes(client);
    await restoreNormalSettings(client);
    
    log('🎉 BILLION-RECORD INGESTION COMPLETED SUCCESSFULLY!');
    
    // Show final statistics
    const stats = await client.query('SELECT COUNT(*) as total_records FROM breaches');
    const size = await client.query("SELECT pg_size_pretty(pg_total_relation_size('breaches')) as table_size");
    
    log(`📊 Final Statistics:`);
    log(`   • Total records: ${parseInt(stats.rows[0].total_records).toLocaleString()}`);
    log(`   • Table size: ${size.rows[0].table_size}`);
    
  } catch (error) {
    errorLog(`Billion-record ingestion failed: ${error.message}`);
    
    try {
      // Attempt to restore normal settings even on failure
      await restoreNormalSettings(client);
    } catch (restoreError) {
      errorLog(`Failed to restore settings: ${restoreError.message}`);
    }
    
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  log('Received SIGINT - attempting graceful shutdown...');
  process.exit(1);
});

process.on('SIGTERM', async () => {
  log('Received SIGTERM - attempting graceful shutdown...');
  process.exit(1);
});

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
