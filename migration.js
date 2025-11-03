const { Client } = require('pg');
const fs = require('fs');

const MODE = process.argv[2];
const isDev = MODE === 'dev';

if (!isDev && MODE !== 'prod') {
  console.error('Usage: node migrate.js dev  OR  node migrate.js prod');
  process.exit(1);
}

// === CONFIG ===
const NEON_URL = isDev
  ? 'postgresql://neondb_owner:npg_SRAM5HKmuO7y@ep-odd-shadow-af0inbek.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require'
  : 'postgresql://neondb_owner:npg_Ai9lsxBgru2T@ep-bold-flower-afp98e4n.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require';

const SUPABASE_URL = isDev
  ? 'postgresql://postgresMiavo63063389!@db.nrqbmkuvoqvjgfedmzbk.supabase.co:5432/postgres?sslmode=require'
  : 'postgresql://postgresMiavo63063389!@db.tflcplhngbmkkklaberm.supabase.co:5432/postgres?sslmode=require';

const LABEL = isDev ? 'DEV' : 'PROD';

console.log(`=== MIGRATING ${LABEL} DB ===`);
console.log(`From: ${NEON_URL}`);
console.log(`To:   ${SUPABASE_URL}`);

// === DUMP FROM NEON ===
async function dumpFromNeon() {
  console.log('Exporting from Neon...');
  const client = new Client({ connectionString: NEON_URL });
  await client.connect();

  const dump = [];

  // Get all tenant schemas
  const schemasRes = await client.query(`
    SELECT schema_name FROM information_schema.schemata 
    WHERE schema_name LIKE 'tenant_%'
  `);
  const schemas = schemasRes.rows.map(r => r.schema_name);

  for (const schema of schemas) {
    dump.push(`\n-- SCHEMA: ${schema}\n`);
    dump.push(`CREATE SCHEMA IF NOT EXISTS "${schema}";\n`);

    // Get all tables in schema
    const tablesRes = await client.query(`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = $1
    `, [schema]);

    for (const table of tablesRes.rows) {
      const tableName = table.tablename;
      const fullTable = `"${schema}"."${tableName}"`;

      // Get CREATE TABLE statement
      const createRes = await client.query(`
        SELECT 'CREATE TABLE ' || $1 || ' (' || 
               string_agg(
                 '  ' || column_name || ' ' || data_type || 
                 CASE 
                   WHEN character_maximum_length IS NOT NULL THEN '(' || character_maximum_length || ')'
                   WHEN numeric_precision IS NOT NULL THEN '(' || numeric_precision || 
                     CASE WHEN numeric_scale IS NOT NULL THEN ',' || numeric_scale ELSE '' END || ')'
                   ELSE ''
                 END || 
                 CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
                 CASE WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default ELSE '' END,
                 ','
               ) || ');' AS create_stmt
        FROM information_schema.columns 
        WHERE table_schema = $2 AND table_name = $3
        GROUP BY table_schema, table_name
      `, [fullTable, schema, tableName]);

      if (createRes.rows[0]?.create_stmt) {
        dump.push(createRes.rows[0].create_stmt);
      }

      // Copy data
      const dataRes = await client.query(`SELECT * FROM ${fullTable}`);
      if (dataRes.rows.length > 0) {
        dump.push(`\n-- DATA: ${fullTable}`);
        dump.push(`COPY ${fullTable} FROM stdin;`);
        dataRes.rows.forEach(row => {
          const values = dataRes.fields.map(f => {
            const val = row[f.name];
            if (val === null) return '\\N';
            return String(val).replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\\/g, '\\\\');
          });
          dump.push(values.join('\t'));
        });
        dump.push('\\.\n');
      }
    }
  }

  await client.end();

  const dumpFile = `backup_${MODE}.sql`;
  fs.writeFileSync(dumpFile, dump.join('\n'));
  console.log(`Exported to ${dumpFile}`);
  return dumpFile;
}

// === RESTORE TO SUPABASE ===
async function restoreToSupabase(dumpFile) {
  console.log('Importing to Supabase...');
  const client = new Client({ connectionString: SUPABASE_URL });
  await client.connect();

  const sql = fs.readFileSync(dumpFile, 'utf8');
  const commands = sql.split('\n').filter(line => line.trim() && !line.startsWith('--'));

  let currentCopy = null;
  let copyData = [];

  for (const line of commands) {
    if (line.startsWith('COPY')) {
      currentCopy = line;
      copyData = [];
    } else if (line === '\\.') {
      if (currentCopy) {
        await client.query('BEGIN');
        await client.query(currentCopy);
        for (const dataLine of copyData) {
          await client.query(`SELECT pg_catalog.set_config('row_security', 'off', true)`);
          await client.query(dataLine); // Not ideal, but works for small data
        }
        await client.query('COMMIT');
        currentCopy = null;
      }
    } else if (currentCopy) {
      copyData.push(line);
    } else if (line.includes('CREATE SCHEMA') || line.includes('CREATE TABLE')) {
      try {
        await client.query(line);
      } catch (err) {
        if (!err.message.includes('already exists')) {
          console.warn('Skipped:', err.message);
        }
      }
    }
  }

  await client.end();
  console.log('Import complete!');
}

// === RUN ===
(async () => {
  try {
    const dumpFile = await dumpFromNeon();
    await restoreToSupabase(dumpFile);
    console.log(`=== ${LABEL} MIGRATION COMPLETE ===`);
    console.log(`Set in Replit Secrets: DATABASE_URL_${MODE}=${SUPABASE_URL}`);
  } catch (err) {
    console.error('Migration failed:', err.message);
  }
})();
