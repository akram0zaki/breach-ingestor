import { Client } from 'pg';

const client = new Client({
  host: '192.168.129.128',
  port: 5432,
  database: 'breachdb',
  user: 'pi',
  password: '<password>'
});

async function quickCheck() {
  try {
    await client.connect();
    console.log('✓ Connected to PostgreSQL');
    
    const result = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'breaches'
      ORDER BY indexname;
    `);
    
    console.log('\n=== CURRENT INDEX STATUS ===');
    if (result.rows.length === 1 && result.rows[0].indexname === 'breaches_pkey') {
      console.log('✅ OPTIMAL FOR BULK IMPORT!');
      console.log('Only primary key index remains');
      console.log('Expected performance boost: 15-25% faster inserts');
    } else {
      console.log('Current indexes:');
      result.rows.forEach(row => {
        const type = row.indexname.includes('pkey') ? 'PRIMARY KEY' : 'REGULAR';
        console.log(`  ${type}: ${row.indexname}`);
      });
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

quickCheck();
