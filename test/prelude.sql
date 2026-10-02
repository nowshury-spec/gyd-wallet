-- Test-only: the handful of Supabase-provided objects supabase/schema.sql
-- expects to already exist, so the real schema file can be loaded into a
-- plain local Postgres unchanged. Never run this against Supabase itself.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text, public boolean);
CREATE TABLE IF NOT EXISTS storage.objects (id bigserial PRIMARY KEY, bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Supabase gives the public roles every new table and function in public by
-- default; copy that so the tests prove schema.sql takes it back.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
