#!/bin/bash
set -e

# === CHOOSE DB: DEV or PROD ===
MODE="$1"

if [ "$MODE" = "dev" ]; then
  NEON_URL="postgresql://neondb_owner:npg_SRAM5HKmuO7y@ep-odd-shadow-af0inbek.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require"
  SUPABASE_URL="postgresql://postgres:Ezio13579674Auditore!@db.nrqbmkuvoqvjgfedmzbk.supabase.co:5432/postgres"
  LABEL="DEV"
elif [ "$MODE" = "prod" ]; then
  NEON_URL="postgresql://neondb_owner:npg_Ai9lsxBgru2T@ep-bold-flower-afp98e4n.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require"
  SUPABASE_URL="postgresql://postgres:Ezio13579674Auditore!@db.tflcplhngbmkkklaberm.supabase.co:5432/postgres"
  LABEL="PROD"
else
  echo "Usage: ./migrate-docker.sh dev  OR  ./migrate-docker.sh prod"
  exit 1
fi

echo "=== MIGRATING $LABEL DB USING DOCKER ==="

# Run pg_dump inside Docker
docker run --rm \
  -e PGPASSWORD=$(echo $NEON_URL | sed -E 's/.*:([^@]+)@.*/\1/') \
  postgres:15 \
  pg_dump \
    --host=$(echo $NEON_URL | sed -E 's/.*@([^:]+).*/\1/') \
    --username=$(echo $NEON_URL | sed -E 's/postgresql:\/\/([^:]+):.*/\1/') \
    --port=5432 \
    --dbname=neondb \
    --format=custom \
    --file=/backup.dump

# Run pg_restore inside Docker
docker run --rm \
  -v $(pwd):/data \
  -e PGPASSWORD=$(echo $SUPABASE_URL | sed -E 's/.*:([^@]+)@.*/\1/') \
  postgres:15 \
  pg_restore \
    --host=$(echo $SUPABASE_URL | sed -E 's/.*@([^:]+).*/\1/') \
    --username=postgres \
    --dbname=postgres \
    --verbose \
    --no-owner \
    --no-acl \
    --clean \
    --if-exists \
    /data/backup.dump

echo "=== $LABEL MIGRATION COMPLETE ==="
echo "UPDATE REPLIT SECRETS:"
echo "DATABASE_URL_$MODE=$SUPABASE_URL"
