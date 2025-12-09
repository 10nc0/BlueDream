const { Client } = require('pg');

const SUPABASE_URL = 'postgresql://postgres:Miavo63063389!@db.nrqbmkuvoqvjgfedmzbk.supabase.co:5432/postgres?sslmode=require';

const client = new Client({ connectionString: SUPABASE_URL });

client.connect()
  .then(() => {
    console.log('CONNECTED!');
    return client.query('SELECT 1');
  })
  .then(() => console.log('QUERY OK!'))
  .catch(err => console.error('FAIL:', err.message))
  .finally(() => client.end());
