-- ===========================================================================
-- Phase 7 Step 1 — Mood Mode database foundation.
--
-- Everything here is SALVAGED from supabase/legacy/0001_init.ABANDONED.sql.
-- That file was retired in Phase 6 because its duo/swipe half described a
-- design that was never built — but its MOOD half was never wrong, only
-- unapplied, and it is exactly what `mood-search` and `embed-media` already
-- expect. This migration ports that half and reconciles it with the schema
-- that actually shipped.
--
-- ── What had to change, and why ────────────────────────────────────────────
-- `match_media` could not be copied across. Its anti-join read
--
--     s.media_item_id = m.id        -- a uuid FK into media_items
--
-- and the live `swipes` table has no such column: it identifies a title by
-- `media_id bigint` (the TMDB id) plus `media_type`. Applied verbatim the
-- function would not even compile. The join is rewritten below against the
-- real column pair.
--
-- ── What deliberately did NOT change ───────────────────────────────────────
-- The uuid surrogate `media_items.id` is kept even though (tmdb_id,
-- media_type) is the natural key and nothing in the live schema references
-- the uuid. Two live consumers depend on it:
--
--   * the client's `MoodResultSchema` declares `id: z.string().uuid()`, so a
--     response without one fails Zod validation before it ever renders;
--   * `embed-media` writes embeddings back with `.eq('id', item.id)`.
--
-- Dropping it as a simplification would have broken both.
-- ===========================================================================

-- pgvector 0.8.x — the version that supports HNSW. Placed in `extensions`,
-- matching where this project already keeps pgcrypto and uuid-ossp.
create extension if not exists vector with schema extensions;

-- ═══════════════════════════════════════════════════════════════════════════
-- media_items — the searchable catalogue
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.media_items (
  id              uuid primary key default extensions.gen_random_uuid(),
  tmdb_id         bigint not null,
  media_type      public.media_kind not null,
  title           text not null,
  original_title  text,
  overview        text,
  poster_path     text,
  backdrop_path   text,
  genres          text[] not null default '{}',
  runtime_minutes integer check (runtime_minutes is null or runtime_minutes > 0),
  release_year    integer,
  vote_average    numeric(3, 1),
  popularity      numeric,
  origin_country  text[] not null default '{}',
  -- 1536 dimensions is not arbitrary: it is the output width of
  -- text-embedding-3-small, and `mood-search` hard-asserts EMBEDDING_DIM.
  -- Changing the model means changing both, plus a full re-embed.
  embedding       extensions.vector(1536),
  created_at      timestamptz not null default now(),
  -- The natural key. This is what an upsert from TMDB conflicts on.
  unique (tmdb_id, media_type)
);

-- HNSW, not ivfflat: it needs no training pass, so it stays correct while the
-- catalogue is still being backfilled. Cosine ops to match the normalised
-- vectors `mood-search` sends.
--
-- Build cost is a function of table size. Creating it now, on an empty table,
-- is instant; creating it after the Step 2 backfill would block for minutes.
create index if not exists media_items_embedding_idx
  on public.media_items using hnsw (embedding extensions.vector_cosine_ops);

-- Serves the `genres && p_genres` overlap filter in match_media.
create index if not exists media_items_genres_idx
  on public.media_items using gin (genres);

create index if not exists media_items_popularity_idx
  on public.media_items (popularity desc nulls last);

-- ═══════════════════════════════════════════════════════════════════════════
-- taste_profiles — the SEMANTIC taste vector
--
-- Not a duplicate of `profiles.taste_profile`, and the two must not be merged.
-- That jsonb column holds genre and person WEIGHTS and drives deck fetching.
-- This holds a 1536-d embedding and drives semantic blending in mood-search
-- (final = 0.7 * query + 0.3 * taste). Different data, different consumers.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.taste_profiles (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  embedding   extensions.vector(1536),
  swipe_count integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- mood_searches — query log
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.mood_searches (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  query      text not null,
  locale     text not null default 'en',
  created_at timestamptz not null default now()
);

create index if not exists mood_searches_user_idx
  on public.mood_searches (user_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- rate_limits — fixed-window counters
--
-- The WINDOW IS A PARAMETER, not a property of this table: `check_rate_limit`
-- takes p_window_seconds and derives the bucket from it. Moving the free tier
-- from 5/hour to a daily cap is therefore a one-line change in the Edge
-- Function and needs no migration.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.rate_limits (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, bucket, window_start)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.media_items    enable row level security;
alter table public.taste_profiles enable row level security;
alter table public.mood_searches  enable row level security;
alter table public.rate_limits    enable row level security;

-- Never FORCE: it would break every SECURITY DEFINER function here, exactly
-- as documented in supabase_schema.sql.
alter table public.media_items    no force row level security;
alter table public.taste_profiles no force row level security;
alter table public.mood_searches  no force row level security;
alter table public.rate_limits    no force row level security;

-- media_items is a shared, non-personal catalogue: readable by any signed-in
-- user, writable only by the service role (no insert/update/delete policy, so
-- RLS denies those to everyone who isn't the table owner).
drop policy if exists "media items: readable" on public.media_items;
create policy "media items: readable" on public.media_items
  for select to authenticated using (true);

-- The remaining three are per-user and SELECT-only. All writes go through
-- Edge Functions running as the service role: a client that could write its
-- own taste vector could steer recommendations, and one that could write
-- rate_limits could erase its own quota.
drop policy if exists "taste profiles: read own" on public.taste_profiles;
create policy "taste profiles: read own" on public.taste_profiles
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "mood searches: read own" on public.mood_searches;
create policy "mood searches: read own" on public.mood_searches
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "rate limits: read own" on public.rate_limits;
create policy "rate limits: read own" on public.rate_limits
  for select to authenticated using (user_id = (select auth.uid()));

-- ═══════════════════════════════════════════════════════════════════════════
-- match_media — semantic search with a per-user exclusion
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.match_media(
  p_query_embedding extensions.vector(1536),
  p_match_count     integer default 20,
  p_media_type      public.media_kind default null,
  p_genres          text[] default null,
  p_max_runtime     integer default null,
  p_min_year        integer default null,
  p_user_id         uuid default null
)
returns table (
  id              uuid,
  tmdb_id         bigint,
  media_type      public.media_kind,
  title           text,
  overview        text,
  poster_path     text,
  backdrop_path   text,
  genres          text[],
  runtime_minutes integer,
  release_year    integer,
  vote_average    numeric,
  similarity      real
)
language sql
stable
security definer
-- Empty search_path with fully-qualified references, per this project's
-- SECURITY DEFINER convention. That is why the distance operator is written
-- as `operator(extensions.<=>)` rather than a bare `<=>`: with no search_path
-- the bare form would not resolve. It is the same operator, so the HNSW index
-- above is still eligible for the ORDER BY.
set search_path = ''
as $function$
  select
    m.id, m.tmdb_id, m.media_type, m.title, m.overview,
    m.poster_path, m.backdrop_path, m.genres, m.runtime_minutes,
    m.release_year, m.vote_average,
    (1 - (m.embedding operator(extensions.<=>) p_query_embedding))::real as similarity
  from public.media_items m
  where m.embedding is not null
    and (p_media_type is null or m.media_type = p_media_type)
    and (p_genres is null or m.genres && p_genres)
    and (p_max_runtime is null or m.runtime_minutes is null or m.runtime_minutes <= p_max_runtime)
    and (p_min_year is null or m.release_year is null or m.release_year >= p_min_year)
    -- THE REWRITE. v1 joined `s.media_item_id = m.id`; the live swipes table
    -- identifies a title by (media_id, media_type) instead, so both halves of
    -- the pair are required — matching on media_id alone would cross-match a
    -- film against a series that happens to share a TMDB id.
    and not exists (
      select 1 from public.swipes s
      where s.user_id = coalesce(p_user_id, (select auth.uid()))
        and s.media_id = m.tmdb_id
        and s.media_type = m.media_type
        and s.direction = 'dislike'
    )
  order by m.embedding operator(extensions.<=>) p_query_embedding
  limit least(greatest(p_match_count, 1), 50);
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- check_rate_limit — atomic fixed-window counter
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.check_rate_limit(
  p_user_id        uuid,
  p_bucket         text,
  p_max            integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  -- Opportunistic cleanup of expired windows for this key, so the table does
  -- not grow without bound and needs no scheduled vacuum job.
  delete from public.rate_limits
  where user_id = p_user_id and bucket = p_bucket and window_start < v_window_start;

  -- The increment and the read are one statement: two concurrent requests
  -- cannot both observe the pre-increment count and both be allowed through.
  insert into public.rate_limits (user_id, bucket, window_start, count)
  values (p_user_id, p_bucket, v_window_start, 1)
  on conflict (user_id, bucket, window_start)
  do update set count = public.rate_limits.count + 1
  returning count into v_count;

  return jsonb_build_object(
    'allowed', v_count <= p_max,
    'remaining', greatest(p_max - v_count, 0),
    'retry_after_seconds',
      ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds) - now())))::integer
  );
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Grants — deliberately none for clients
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Both functions are called ONLY by Edge Functions holding the service-role
-- key, which bypasses these grants entirely. Neither is granted to `anon` or
-- `authenticated`, and that is a security decision rather than an oversight:
--
--   * match_media takes p_user_id and runs SECURITY DEFINER. Exposed to a
--     client, a caller could pass someone else's id and infer that user's
--     dislikes by diffing which titles disappear from the results.
--   * check_rate_limit INCREMENTS on call. Exposed to a client, anyone could
--     burn their own quota — or, worse, another user's — by calling it
--     directly.
--
-- The explicit revoke matters because a freshly created function carries
-- EXECUTE for PUBLIC by default.
revoke execute on function public.match_media(
  extensions.vector, integer, public.media_kind, text[], integer, integer, uuid
) from public, anon, authenticated;

revoke execute on function public.check_rate_limit(uuid, text, integer, integer)
  from public, anon, authenticated;
