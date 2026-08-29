-- Supabase-compatible preamble for a vanilla postgres:17 container.
-- This is a TEST HARNESS ONLY — it is not part of the app's migration. It
-- recreates the pieces Supabase provides (roles, the auth schema, auth.uid(),
-- the realtime publication) so that supabase_schema.sql can be executed and
-- its RLS policies exercised for real.

create schema if not exists extensions;

-- ── Roles, as Supabase defines them ────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public, extensions to anon, authenticated, service_role;

-- Supabase grants table access broadly and relies on RLS for isolation. The
-- harness must mirror that, or an RLS test would "pass" for the wrong reason:
-- a plain permission denial instead of a policy denial.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- ── auth schema ────────────────────────────────────────────────────────────
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id                 uuid primary key default pg_catalog.gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Same definition Supabase ships: read the subject out of the request GUC.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

-- ── Realtime publication ───────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;
