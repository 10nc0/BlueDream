const { Client } = require('pg');

const SUPABASE_URL = 'postgresql://postgres.tflcplhngbmkkklaberm:Miavo63063389!@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres';

const client = new Client({ 
  connectionString: SUPABASE_URL,
  ssl: { rejectUnauthorized: false }
});

client.connect()
  .then(() => {
    console.log('CONNECTED!');
    return client.query('SELECT 1');
  })
  .then(() => console.log('QUERY OK!'))
  .catch(err => console.error('FAIL:', err.message))
  .finally(() => client.end());
