-- ═══════════════════════════════════════════════════════════════════════════
-- CineSwipe — initial schema
-- PostgreSQL 15 + pgvector (>= 0.7 for l2_normalize / HNSW)
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── Enums ──────────────────────────────────────────────────────────────────

create type public.media_kind as enum ('movie', 'tv');
-- 'seen' = the user has already watched it: excluded from the deck and a mild
-- positive taste signal, but never a Watchlist entry.
create type public.swipe_direction as enum ('like', 'dislike', 'superlike', 'seen');
create type public.engagement_source as enum ('ai', 'community');
create type public.duo_status as enum ('waiting', 'active', 'completed', 'cancelled');

-- ── Tables ─────────────────────────────────────────────────────────────────

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text unique,
  locale        text not null default 'en' check (locale in ('en', 'he')),
  country_code  text not null default 'US' check (char_length(country_code) = 2),
  is_premium    boolean not null default false,
  swipes_today  integer not null default 0 check (swipes_today >= 0),
  swipe_date    date not null default current_date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.media_items (
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
  embedding       extensions.vector(1536),
  created_at      timestamptz not null default now(),
  unique (tmdb_id, media_type)
);

create index media_items_embedding_idx
  on public.media_items
  using hnsw (embedding extensions.vector_cosine_ops);

create index media_items_genres_idx on public.media_items using gin (genres);
create index media_items_popularity_idx on public.media_items (popularity desc nulls last);

create table public.taste_profiles (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  embedding   extensions.vector(1536),
  swipe_count integer not null default 0,
  updated_at  timestamptz not null default now()
);

create table public.swipes (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  media_item_id uuid not null references public.media_items (id) on delete cascade,
  direction     public.swipe_direction not null,
  created_at    timestamptz not null default now(),
  unique (user_id, media_item_id)
);

create index swipes_user_idx on public.swipes (user_id, created_at desc);

-- "When It Gets Good" — engagement spikes per episode minute.
create table public.engagement_points (
  id            bigint generated always as identity primary key,
  media_item_id uuid not null references public.media_items (id) on delete cascade,
  season        integer not null default 1 check (season >= 0),
  episode       integer not null check (episode >= 1),
  minute        integer not null check (minute >= 0),
  score         numeric not null check (score >= 0 and score <= 1),
  source        public.engagement_source not null default 'community',
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index engagement_points_media_idx
  on public.engagement_points (media_item_id, season, episode, minute);

create table public.duo_sessions (
  id         uuid primary key default extensions.gen_random_uuid(),
  code       text not null unique default upper(encode(extensions.gen_random_bytes(4), 'hex')),
  host_id    uuid not null references public.profiles (id) on delete cascade,
  guest_id   uuid references public.profiles (id) on delete set null,
  status     public.duo_status not null default 'waiting',
  created_at timestamptz not null default now(),
  check (guest_id is null or guest_id <> host_id)
);

create table public.duo_picks (
  id            bigint generated always as identity primary key,
  session_id    uuid not null references public.duo_sessions (id) on delete cascade,
  media_item_id uuid not null references public.media_items (id) on delete cascade,
  score         real not null,
  rank          integer not null check (rank between 1 and 10),
  created_at    timestamptz not null default now(),
  unique (session_id, rank)
);

create table public.mood_searches (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  query      text not null,
  locale     text not null default 'en',
  created_at timestamptz not null default now()
);

create index mood_searches_user_idx on public.mood_searches (user_id, created_at desc);

-- Fixed-window rate limiting, written only by Edge Functions (service role).
create table public.rate_limits (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, bucket, window_start)
);

-- ── updated_at maintenance ─────────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger taste_profiles_touch_updated_at
  before update on public.taste_profiles
  for each row execute function public.touch_updated_at();

-- ── Signup bootstrap ───────────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locale text;
begin
  v_locale := new.raw_user_meta_data ->> 'locale';
  if v_locale is null or v_locale not in ('en', 'he') then
    v_locale := 'en';
  end if;

  insert into public.profiles (id, username, locale)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'username', ''),
      split_part(coalesce(new.email, 'viewer'), '@', 1) || '_' || left(new.id::text, 4)
    ),
    v_locale
  );

  insert into public.taste_profiles (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Vector helpers ─────────────────────────────────────────────────────────

-- Constant vector [x, x, …] of dimension 1536 (pgvector has no scalar ops,
-- but element-wise * with a constant vector is equivalent).
create or replace function public.const_vec(x double precision)
returns extensions.vector
language sql
immutable
set search_path = public, extensions
as $$
  select array_fill(x::real, array[1536])::extensions.vector(1536);
$$;

-- Exponential moving average of a taste profile toward (or away from) an item.
-- result = normalize(profile * (1 - alpha) + item * (alpha * sign))
create or replace function public.vector_ema(
  p_profile extensions.vector,
  p_item    extensions.vector,
  p_alpha   real,
  p_sign    real
)
returns extensions.vector
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when p_profile is null then
      extensions.l2_normalize(p_item * public.const_vec(p_sign))
    else
      extensions.l2_normalize(
        p_profile * public.const_vec(1 - p_alpha)
        + p_item * public.const_vec(p_alpha * p_sign)
      )
  end;
$$;

-- ── RPC: hydrate TMDB metadata (embedding filled later by embed-media fn) ──

create or replace function public.upsert_media_items(p_items jsonb)
returns setof public.media_items
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 40 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  return query
  insert into public.media_items as m (
    tmdb_id, media_type, title, original_title, overview,
    poster_path, backdrop_path, genres, runtime_minutes,
    release_year, vote_average, popularity, origin_country
  )
  select
    (i ->> 'tmdb_id')::bigint,
    (i ->> 'media_type')::public.media_kind,
    i ->> 'title',
    i ->> 'original_title',
    i ->> 'overview',
    i ->> 'poster_path',
    i ->> 'backdrop_path',
    coalesce((select array_agg(g) from jsonb_array_elements_text(i -> 'genres') g), '{}'),
    nullif(i ->> 'runtime_minutes', '')::integer,
    nullif(i ->> 'release_year', '')::integer,
    nullif(i ->> 'vote_average', '')::numeric,
    nullif(i ->> 'popularity', '')::numeric,
    coalesce((select array_agg(c) from jsonb_array_elements_text(i -> 'origin_country') c), '{}')
  from jsonb_array_elements(p_items) i
  where (i ->> 'tmdb_id') is not null
    and (i ->> 'media_type') in ('movie', 'tv')
    and (i ->> 'title') is not null
  on conflict (tmdb_id, media_type) do update set
    title           = excluded.title,
    original_title  = excluded.original_title,
    overview        = excluded.overview,
    poster_path     = excluded.poster_path,
    backdrop_path   = excluded.backdrop_path,
    genres          = excluded.genres,
    runtime_minutes = coalesce(excluded.runtime_minutes, m.runtime_minutes),
    release_year    = coalesce(excluded.release_year, m.release_year),
    vote_average    = coalesce(excluded.vote_average, m.vote_average),
    popularity      = coalesce(excluded.popularity, m.popularity),
    origin_country  = excluded.origin_country
  returning m.*;
end;
$$;

-- ── RPC: record a swipe (server-enforced daily quota + taste EMA update) ───

create or replace function public.apply_swipe(
  p_media_item_id uuid,
  p_direction     public.swipe_direction
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  c_free_daily_limit constant integer := 50;
  c_alpha            constant real := 0.15;
  v_user      uuid := auth.uid();
  v_profile   public.profiles%rowtype;
  v_today     integer;
  v_item_emb  extensions.vector(1536);
  v_taste     extensions.vector(1536);
  v_sign      real;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_user for update;
  if not found then
    raise exception 'profile_missing' using errcode = 'P0002';
  end if;

  v_today := case when v_profile.swipe_date = current_date then v_profile.swipes_today else 0 end;

  if not v_profile.is_premium and v_today >= c_free_daily_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'quota_exhausted',
      'swipes_remaining', 0,
      'is_premium', false
    );
  end if;

  insert into public.swipes (user_id, media_item_id, direction)
  values (v_user, p_media_item_id, p_direction)
  on conflict (user_id, media_item_id)
  do update set direction = excluded.direction, created_at = now();

  update public.profiles
  set swipes_today = v_today + 1, swipe_date = current_date
  where id = v_user;

  select embedding into v_item_emb from public.media_items where id = p_media_item_id;

  if v_item_emb is not null then
    v_sign := case p_direction
      when 'like' then 1.0
      when 'superlike' then 1.5
      when 'seen' then 0.5
      when 'dislike' then -1.0
    end;

    select embedding into v_taste
    from public.taste_profiles where user_id = v_user for update;

    insert into public.taste_profiles (user_id, embedding, swipe_count)
    values (v_user, public.vector_ema(v_taste, v_item_emb, c_alpha, v_sign), 1)
    on conflict (user_id) do update set
      embedding   = public.vector_ema(v_taste, v_item_emb, c_alpha, v_sign),
      swipe_count = public.taste_profiles.swipe_count + 1;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'swipes_remaining',
      case when v_profile.is_premium then null
           else c_free_daily_limit - (v_today + 1) end,
    'is_premium', v_profile.is_premium
  );
end;
$$;

-- ── RPC: cosine match against the catalogue ────────────────────────────────

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
set search_path = public, extensions
as $$
  select
    m.id, m.tmdb_id, m.media_type, m.title, m.overview,
    m.poster_path, m.backdrop_path, m.genres, m.runtime_minutes,
    m.release_year, m.vote_average,
    (1 - (m.embedding <=> p_query_embedding))::real as similarity
  from public.media_items m
  where m.embedding is not null
    and (p_media_type is null or m.media_type = p_media_type)
    and (p_genres is null or m.genres && p_genres)
    and (p_max_runtime is null or m.runtime_minutes is null or m.runtime_minutes <= p_max_runtime)
    and (p_min_year is null or m.release_year is null or m.release_year >= p_min_year)
    and not exists (
      select 1 from public.swipes s
      where s.user_id = coalesce(p_user_id, auth.uid())
        and s.media_item_id = m.id
        and s.direction = 'dislike'
    )
  order by m.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 50);
$$;

-- ── RPC: Duo-Match ─────────────────────────────────────────────────────────

create or replace function public.join_duo_session(p_session_id uuid)
returns public.duo_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.duo_sessions;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  update public.duo_sessions
  set guest_id = v_user, status = 'active'
  where id = p_session_id
    and status = 'waiting'
    and guest_id is null
    and host_id <> v_user
  returning * into v_row;

  if not found then
    -- Re-joining your own session (host or existing guest) is a no-op success.
    select * into v_row from public.duo_sessions
    where id = p_session_id and (host_id = v_user or guest_id = v_user);
    if not found then
      raise exception 'duo_session_unavailable' using errcode = 'P0002';
    end if;
  end if;

  return v_row;
end;
$$;

-- Intersects both members' taste vectors and stores the 3 best mutual picks.
create or replace function public.duo_match(p_session_id uuid)
returns table (
  media_item_id uuid,
  tmdb_id       bigint,
  media_type    public.media_kind,
  title         text,
  poster_path   text,
  score         real,
  rank          integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user     uuid := auth.uid();
  v_session  public.duo_sessions;
  v_host_emb extensions.vector(1536);
  v_guest_emb extensions.vector(1536);
  v_combined extensions.vector(1536);
begin
  select * into v_session from public.duo_sessions where id = p_session_id;
  if not found then
    raise exception 'duo_session_unavailable' using errcode = 'P0002';
  end if;

  -- Caller must be a member — or the service role (auth.uid() is null there).
  if v_user is not null and v_user not in (v_session.host_id, coalesce(v_session.guest_id, v_session.host_id)) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  if v_session.guest_id is null then
    raise exception 'duo_session_not_ready' using errcode = 'P0003';
  end if;

  select embedding into v_host_emb from public.taste_profiles where user_id = v_session.host_id;
  select embedding into v_guest_emb from public.taste_profiles where user_id = v_session.guest_id;

  if v_host_emb is null or v_guest_emb is null then
    raise exception 'taste_profile_incomplete' using errcode = 'P0004';
  end if;

  v_combined := extensions.l2_normalize(v_host_emb + v_guest_emb);

  delete from public.duo_picks where session_id = p_session_id;

  return query
  with ranked as (
    select
      m.id, m.tmdb_id, m.media_type, m.title, m.poster_path,
      (1 - (m.embedding <=> v_combined))::real as s,
      row_number() over (order by m.embedding <=> v_combined) as r
    from public.media_items m
    where m.embedding is not null
      and not exists (
        select 1 from public.swipes sw
        where sw.media_item_id = m.id
          and sw.user_id in (v_session.host_id, v_session.guest_id)
          and sw.direction = 'dislike'
      )
    limit 200
  ),
  inserted as (
    insert into public.duo_picks (session_id, media_item_id, score, rank)
    select p_session_id, ranked.id, ranked.s, ranked.r
    from ranked
    where ranked.r <= 3
    returning duo_picks.media_item_id, duo_picks.score, duo_picks.rank
  )
  select i.media_item_id, rk.tmdb_id, rk.media_type, rk.title, rk.poster_path, i.score, i.rank
  from inserted i
  join ranked rk on rk.id = i.media_item_id
  order by i.rank;
end;
$$;

-- ── RPC: fixed-window rate limiting (called by Edge Functions) ─────────────

create or replace function public.check_rate_limit(
  p_user_id        uuid,
  p_bucket         text,
  p_max            integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  -- Opportunistic cleanup of expired windows for this key.
  delete from public.rate_limits
  where user_id = p_user_id and bucket = p_bucket and window_start < v_window_start;

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
$$;

-- ── RPC: premium viewing stats ─────────────────────────────────────────────

create or replace function public.get_user_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'total_swipes', (select count(*) from public.swipes where user_id = auth.uid()),
    'likes',        (select count(*) from public.swipes where user_id = auth.uid() and direction = 'like'),
    'superlikes',   (select count(*) from public.swipes where user_id = auth.uid() and direction = 'superlike'),
    'dislikes',     (select count(*) from public.swipes where user_id = auth.uid() and direction = 'dislike'),
    'top_genres', coalesce((
      select jsonb_agg(jsonb_build_object('genre', g.genre, 'count', g.cnt))
      from (
        select unnest(m.genres) as genre, count(*) as cnt
        from public.swipes s
        join public.media_items m on m.id = s.media_item_id
        where s.user_id = auth.uid() and s.direction in ('like', 'superlike')
        group by 1
        order by 2 desc
        limit 5
      ) g
    ), '[]'::jsonb)
  );
$$;

-- ── Row Level Security ─────────────────────────────────────────────────────

alter table public.profiles          enable row level security;
alter table public.media_items       enable row level security;
alter table public.taste_profiles    enable row level security;
alter table public.swipes            enable row level security;
alter table public.engagement_points enable row level security;
alter table public.duo_sessions      enable row level security;
alter table public.duo_picks         enable row level security;
alter table public.mood_searches     enable row level security;
alter table public.rate_limits       enable row level security; -- no policies: service role only

create policy "profiles: read own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "profiles: update own (never premium flag via RLS alone)"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "media: readable by signed-in users"
  on public.media_items for select
  to authenticated
  using (true);

create policy "taste: read own"
  on public.taste_profiles for select
  to authenticated
  using (user_id = auth.uid());

create policy "swipes: read own"
  on public.swipes for select
  to authenticated
  using (user_id = auth.uid());

create policy "swipes: delete own"
  on public.swipes for delete
  to authenticated
  using (user_id = auth.uid());

create policy "engagement: readable by signed-in users"
  on public.engagement_points for select
  to authenticated
  using (true);

create policy "engagement: community contributions"
  on public.engagement_points for insert
  to authenticated
  with check (source = 'community' and created_by = auth.uid());

create policy "duo sessions: members read"
  on public.duo_sessions for select
  to authenticated
  using (host_id = auth.uid() or guest_id = auth.uid());

create policy "duo sessions: host creates"
  on public.duo_sessions for insert
  to authenticated
  with check (host_id = auth.uid());

create policy "duo sessions: host updates"
  on public.duo_sessions for update
  to authenticated
  using (host_id = auth.uid())
  with check (host_id = auth.uid());

create policy "duo picks: members read"
  on public.duo_picks for select
  to authenticated
  using (exists (
    select 1 from public.duo_sessions ds
    where ds.id = session_id and (ds.host_id = auth.uid() or ds.guest_id = auth.uid())
  ));

create policy "mood searches: read own"
  on public.mood_searches for select
  to authenticated
  using (user_id = auth.uid());

-- ── Function grants ────────────────────────────────────────────────────────

revoke execute on all functions in schema public from public, anon;

grant execute on function public.upsert_media_items(jsonb)                          to authenticated;
grant execute on function public.apply_swipe(uuid, public.swipe_direction)          to authenticated;
grant execute on function public.match_media(extensions.vector, integer, public.media_kind, text[], integer, integer, uuid) to authenticated, service_role;
grant execute on function public.join_duo_session(uuid)                             to authenticated;
grant execute on function public.duo_match(uuid)                                    to authenticated, service_role;
grant execute on function public.check_rate_limit(uuid, text, integer, integer)     to service_role;
grant execute on function public.get_user_stats()                                   to authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────

alter publication supabase_realtime add table public.duo_sessions;
alter publication supabase_realtime add table public.duo_picks;
