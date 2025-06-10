#!/usr/bin/env node

import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function checkDatabase() {
    const PG = {
        user:     process.env.PG_USER     || 'pi',
        host:     '192.168.129.128',  // Use Pi 5 IP instead of localhost
        database: process.env.PG_DATABASE || 'breachdb',
        port:     parseInt(process.env.PG_PORT, 10) || 5432,
        password: process.env.PG_PASSWORD
    };

  console.log('Connecting to PostgreSQL with configuration:');
    console.log(`  User: ${PG.user}`);
    console.log(`  Host: ${PG.host}`);
    console.log(`  Database: ${PG.database}`);
    console.log(`  Port: ${PG.port}`);
    if (PG.password) {
        console.log('  Password: Provided');
    }
  const client = new Client(PG);
//   console.log('Connection string:', process.env.PG_CONN);
//   const client = new Client({
//     connectionString: process.env.PG_CONN
//   });
  
  try {
    await client.connect();
    console.log('✓ Connected to PostgreSQL successfully');
    
    // Check if breaches table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'breaches'
      );
    `);
    
    console.log('Breaches table exists:', tableCheck.rows[0].exists);
    
    if (tableCheck.rows[0].exists) {
      // Get table schema
      const schemaResult = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'breaches'
        ORDER BY ordinal_position;
      `);
      
      console.log('\nTable schema:');
      schemaResult.rows.forEach(col => {
        console.log(`  ${col.column_name}: ${col.data_type} ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
      });
      
      // Check for constraints
      const constraintResult = await client.query(`
        SELECT 
          c.conname as constraint_name,
          c.contype as constraint_type,
          CASE 
            WHEN c.contype = 'u' THEN 'UNIQUE'
            WHEN c.contype = 'p' THEN 'PRIMARY KEY'
            WHEN c.contype = 'f' THEN 'FOREIGN KEY'
            WHEN c.contype = 'c' THEN 'CHECK'
            ELSE c.contype::text
          END as constraint_description
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 'breaches'
          AND c.contype IN ('u', 'p')
        ORDER BY c.contype, c.conname;
      `);
      
      console.log('\n=== CONSTRAINTS ===');
      if (constraintResult.rows.length === 0) {
        console.log('❌ No unique constraints or primary keys found');
      } else {
        constraintResult.rows.forEach(row => {
          console.log(`✓ ${row.constraint_description}: ${row.constraint_name}`);
        });
      }
      
      // Check for indexes
      const indexResult = await client.query(`
        SELECT 
          indexname,
          indexdef
        FROM pg_indexes
        WHERE tablename = 'breaches'
        ORDER BY indexname;
      `);
      
      console.log('\n=== INDEXES ===');
      if (indexResult.rows.length === 0) {
        console.log('❌ No indexes found');
      } else {
        indexResult.rows.forEach(row => {
          console.log(`✓ ${row.indexname}`);
          console.log(`  Definition: ${row.indexdef}`);
        });
      }
      
      // Check row count
      const countResult = await client.query('SELECT COUNT(*) as total_rows FROM breaches');
      console.log(`\n=== STATISTICS ===`);
      console.log(`Total rows: ${parseInt(countResult.rows[0].total_rows).toLocaleString()}`);
    }
      } catch (error) {
    console.error('❌ Database error:');
    console.error('  Message:', error.message);
    console.error('  Code:', error.code);
    console.error('  Stack:', error.stack);
  } finally {
    await client.end();
  }
}

checkDatabase().catch(console.error);
