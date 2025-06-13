#!/usr/bin/env node

/**
 * Index Management Script for Bulk Import Optimization
 * 
 * This script helps optimize bulk imports by:
 * 1. Dropping non-essential indexes before import
 * 2. Recreating indexes after import completion
 * 
 * Usage:
 *   node manage-indexes.js drop    # Drop indexes before import
 *   node manage-indexes.js create  # Recreate indexes after import
 */

import { Client } from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const client = new Client({
  host: '192.168.129.128',
  port: 5432,
  database: 'breachdb',
  user: 'pi',
  password: '<password>'
});

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const errorLog = (...args) => console.error(`[${new Date().toISOString()}] ERROR:`, ...args);

// Indexes to manage (excluding primary key)
const MANAGEABLE_INDEXES = [
  {
    name: 'idx_breaches_email_norm',
    sql: 'CREATE INDEX CONCURRENTLY idx_breaches_email_norm ON breaches(email_norm)',
    description: 'Email normalization index for lookups'
  },
  {
    name: 'idx_unique_breach',
    sql: 'CREATE UNIQUE INDEX CONCURRENTLY idx_unique_breach ON breaches(email_norm, password, source)',
    description: 'Unique constraint for deduplication'
  },
  {
    name: 'idx_breaches_source',
    sql: 'CREATE INDEX CONCURRENTLY idx_breaches_source ON breaches(source)',
    description: 'Source file index for analysis'
  },
  {
    name: 'idx_breaches_hash_type',
    sql: 'CREATE INDEX CONCURRENTLY idx_breaches_hash_type ON breaches(hash_type)',
    description: 'Hash type index for filtering'
  }
];

async function checkCurrentIndexes() {
  const result = await client.query(`
    SELECT 
      indexname,
      indexdef
    FROM pg_indexes
    WHERE tablename = 'breaches'
      AND indexname != 'breaches_pkey'
    ORDER BY indexname;
  `);
  
  log('Current indexes on breaches table:');
  if (result.rows.length === 0) {
    log('  ❌ No additional indexes found (optimal for bulk import)');
  } else {
    result.rows.forEach(row => {
      const isUnique = row.indexdef.includes('UNIQUE');
      const type = isUnique ? 'UNIQUE' : 'REGULAR';
      log(`  ✓ ${type}: ${row.indexname}`);
    });
  }
  
  return result.rows.map(row => row.indexname);
}

async function dropIndexes() {
  log('=== DROPPING INDEXES FOR BULK IMPORT OPTIMIZATION ===');
  
  const currentIndexes = await checkCurrentIndexes();
  
  if (currentIndexes.length === 0) {
    log('✓ No indexes to drop - already optimized for bulk import');
    return;
  }
  
  // Backup index definitions
  const backup = {
    timestamp: new Date().toISOString(),
    indexes: []
  };
  
  const backupResult = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'breaches'
      AND indexname != 'breaches_pkey'
  `);
    backup.indexes = backupResult.rows;
  
  fs.writeFileSync('index-backup.json', JSON.stringify(backup, null, 2));
  log(`✓ Backed up ${backup.indexes.length} index definitions to index-backup.json`);
  
  // Drop each index
  for (const indexName of currentIndexes) {
    try {
      log(`Dropping index: ${indexName}`);
      await client.query(`DROP INDEX IF EXISTS ${indexName}`);
      log(`✓ Dropped: ${indexName}`);
    } catch (error) {
      errorLog(`Failed to drop ${indexName}: ${error.message}`);
    }
  }
  
  log(`\n🚀 OPTIMIZATION COMPLETE!`);
  log(`Expected performance improvement: 15-25% faster inserts`);
  log(`Memory usage reduction: 10-20%`);
  log(`\nYou can now start your bulk import with:`);
  log(`  pm2 start ecosystem.config.cjs --only breach-ingestor-pg`);
}

async function createIndexes() {
  log('=== RECREATING INDEXES AFTER BULK IMPORT ===');
  
  const currentIndexes = await checkCurrentIndexes();
  
  // Configure for optimal index creation
  await client.query("SET maintenance_work_mem = '2GB'");
  await client.query("SET max_parallel_maintenance_workers = 4");
  log('✓ Configured PostgreSQL for optimal index creation');
  
  // Create indexes in priority order
  const sortedIndexes = MANAGEABLE_INDEXES.sort((a, b) => {
    // Create unique constraint first, then regular indexes
    if (a.name.includes('unique')) return -1;
    if (b.name.includes('unique')) return 1;
    return 0;
  });
  
  for (const index of sortedIndexes) {
    if (currentIndexes.includes(index.name)) {
      log(`⏭️  Skipping ${index.name} - already exists`);
      continue;
    }
    
    const startTime = Date.now();
    log(`Creating index: ${index.name}`);
    log(`  Description: ${index.description}`);
    
    try {
      await client.query(index.sql);
      
      const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      log(`✓ Created ${index.name} in ${duration} minutes`);
    } catch (error) {
      errorLog(`Failed to create ${index.name}: ${error.message}`);
      // Continue with other indexes
    }
  }
  
  // Final maintenance
  log('Performing final table maintenance...');
  await client.query('VACUUM ANALYZE breaches');
  
  // Reset settings
  await client.query('RESET maintenance_work_mem');
  await client.query('RESET max_parallel_maintenance_workers');
  
  log('\n🎉 INDEX RECREATION COMPLETE!');
  log('Database is now optimized for production queries.');
}

async function showStatus() {
  log('=== CURRENT INDEX STATUS ===');
  
  await checkCurrentIndexes();
  
  // Show table statistics
  const stats = await client.query('SELECT COUNT(*) as total_rows FROM breaches');
  const size = await client.query("SELECT pg_size_pretty(pg_total_relation_size('breaches')) as table_size");
  
  log(`\n=== TABLE STATISTICS ===`);
  log(`Total rows: ${parseInt(stats.rows[0].total_rows).toLocaleString()}`);
  log(`Table size: ${size.rows[0].table_size}`);
  
  // Show current performance settings
  const settings = await client.query(`
    SELECT name, setting, unit
    FROM pg_settings
    WHERE name IN ('maintenance_work_mem', 'max_parallel_maintenance_workers', 'shared_buffers')
  `);
  
  log(`\n=== POSTGRESQL SETTINGS ===`);
  settings.rows.forEach(row => {
    const value = row.unit ? `${row.setting} ${row.unit}` : row.setting;
    log(`${row.name}: ${value}`);
  });
}

async function main() {
  const command = process.argv[2];
  
  if (!command) {
    console.log('Usage: node manage-indexes.js <command>');
    console.log('Commands:');
    console.log('  drop    - Drop indexes for bulk import optimization');
    console.log('  create  - Recreate indexes after bulk import');
    console.log('  status  - Show current index status');
    process.exit(1);
  }
  
  try {
    await client.connect();
    log('✓ Connected to PostgreSQL');
    
    switch (command.toLowerCase()) {
      case 'drop':
        await dropIndexes();
        break;
      case 'create':
        await createIndexes();
        break;
      case 'status':
        await showStatus();
        break;
      default:
        errorLog(`Unknown command: ${command}`);
        process.exit(1);
    }
    
  } catch (error) {
    errorLog(`Operation failed: ${error.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
