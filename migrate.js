const { Client } = require('pg');
const fs = require('fs');

const MODE = process.argv[2];
const isDev = MODE === 'dev';

if (!isDev && MODE !== 'prod') {
  console.error('Usage: node migrate.js dev  OR  node migrate.js prod');
  process.exit(1);
}

const NEON_URL = isDev
  ? 'postgresql://neondb_owner:npg_SRAM5HKmuO7y@ep-odd-shadow-af0inbek.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require'
  : 'postgresql://neondb_owner:npg_Ai9lsxBgru2T@ep-bold-flower-afp98e4n.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require';

const SUPABASE_URL = isDev
  ? 'postgresql://postgres.nrqbmkuvoqvjgfedmzbk:Miavo63063389!@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres'
  : 'postgresql://postgres.tflcplhngbmkkklaberm:Miavo63063389!@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres';

const LABEL = isDev ? 'DEV' : 'PROD';

console.log(`=== MIGRATING ${LABEL} DB ===`);
console.log(`From: ${NEON_URL}`);
console.log(`To:   ${SUPABASE_URL}`);

async function dumpFromNeon() {
  console.log('Exporting from Neon...');
  const client = new Client({ connectionString: NEON_URL });
  await client.connect();

  const dump = [];

  const schemasRes = await client.query(`
    SELECT nspname AS schema_name 
    FROM pg_namespace 
    WHERE nspname LIKE 'tenant_%' OR nspname = 'core'
    ORDER BY nspname
  `);
  const schemas = schemasRes.rows.map(r => r.schema_name);

  if (schemas.length === 0) {
    console.log('No tenant schemas found.');
    await client.end();
    return null;
  }

  for (const schema of schemas) {
    dump.push(`\n-- SCHEMA: ${schema}\n`);
    dump.push(`CREATE SCHEMA IF NOT EXISTS "${schema}";\n`);

    const tablesRes = await client.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = $1
      ORDER BY tablename
    `, [schema]);

    for (const table of tablesRes.rows) {
      const tableName = table.tablename;
      const fullTable = `"${schema}"."${tableName}"`;

      const colsRes = await client.query(`
        SELECT 
          a.attname AS column_name,
          pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
          CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE '' END AS not_null
        FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [fullTable]);

      const hasId = colsRes.rows.some(c => c.column_name === 'id');

      const cols = colsRes.rows.map(c => 
        `  "${c.column_name}" ${c.data_type} ${c.not_null}`
      ).join(',\n');

      dump.push(`CREATE TABLE ${fullTable} (\n${cols}\n);\n`);

      const dataRes = await client.query(`SELECT * FROM ${fullTable}`);
      if (dataRes.rows.length > 0) {
        for (const row of dataRes.rows) {
          const values = dataRes.fields.map(f => {
            const val = row[f.name];
            if (val === null || val === undefined) return 'NULL';
            if (f.dataTypeID === 20 || f.dataTypeID === 23) return val;
            if (f.dataTypeID === 16) return val ? 'true' : 'false';
            if (f.dataTypeID === 1082) return `'${val.toISOString().split('T')[0]}'`;
            if (f.dataTypeID === 1114 || f.dataTypeID === 1184) {
              return `'${val.toISOString().replace('Z', '')}'`;
            }
            if (f.dataTypeID === 114 || f.dataTypeID === 3802) {
              return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            }
            if (f.dataTypeID === 1009 || f.dataTypeID === 1007) {
              if (Array.isArray(val) && val.length === 0) return `'{}'`;
              return `'${val.map(v => String(v).replace(/'/g, "''")).join(',')}'`;
            }
            if (f.dataTypeID === 17) {
              return `decode('${Buffer.from(val).toString('hex')}', 'hex')`;
            }
            return `'${String(val).replace(/'/g, "''")}'`;
          }).join(', ');

          if (hasId) {
            dump.push(`INSERT INTO ${fullTable} OVERRIDING SYSTEM VALUE VALUES (${values});\n`);
          } else {
            const columns = dataRes.fields.map(f => `"${f.name}"`).join(', ');
            dump.push(`INSERT INTO ${fullTable} (${columns}) VALUES (${values});\n`);
          }
        }
      }
    }
  }

  await client.end();

  const dumpFile = `backup_${MODE}.sql`;
  fs.writeFileSync(dumpFile, dump.join('\n'));
  console.log(`Exported to ${dumpFile}`);
  return dumpFile;
}

async function restoreToSupabase(dumpFile) {
  console.log('Importing to Supabase...');
  const client = new Client({ 
    connectionString: SUPABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const lines = fs.readFileSync(dumpFile, 'utf8').split('\n');
  let buffer = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;

    buffer += line + '\n';

    if (trimmed.endsWith(';')) {
      try {
        await client.query(buffer);
        const stmt = buffer.trim();
        if (stmt.includes('CREATE SCHEMA')) {
          console.log(`Created: SCHEMA ${stmt.match(/"([^"]+)"/)[1]}`);
        } else if (stmt.includes('CREATE TABLE')) {
          console.log(`Created: TABLE ${stmt.match(/"([^"]+)"\."([^"]+)"/).slice(1).join('.')}`);
        } else if (stmt.includes('INSERT INTO')) {
          console.log(`Inserted into ${stmt.match(/INSERT INTO\s+([^ ]+)/)[1]}`);
        }
      } catch (err) {
        if (!err.message.includes('already exists') && !err.message.includes('duplicate key')) {
          console.warn('SQL failed:', err.message);
        }
      }
      buffer = '';
    }
  }

  await client.end();
  console.log('Import complete!');
}

(async () => {
  try {
    const dumpFile = await dumpFromNeon();
    if (dumpFile) {
      await restoreToSupabase(dumpFile);
      console.log(`=== ${LABEL} MIGRATION COMPLETE ===`);
      console.log(`Set in Replit Secrets: DATABASE_URL_${MODE.toUpperCase()}=${SUPABASE_URL}`);
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
  }
})();
