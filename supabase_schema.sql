-- ═══════════════════════════════════════════════════════════════════════════
-- CineSwipe — Run 4 cloud schema
--
-- Target: Supabase / PostgreSQL 17. Executable and IDEMPOTENT: running it
-- twice is a no-op, so it is safe to re-apply after an edit.
--
-- ── Relationship to supabase/migrations/0001_init.sql ──────────────────────
-- 0001_init is the pgvector generation: it models a title as a row in
-- `media_items` and keys swipes on that row's uuid. THIS schema keys directly
-- on the TMDB id instead, because that is what the client actually holds — the
-- store's library, the Duo deck and the recommendation engine all speak
-- `media_type:tmdb_id`, and the uuid indirection meant nothing could be written
-- without a prior round-trip to hydrate `media_items` first.
--
-- The two are therefore NOT compatible on `public.swipes`. This file refuses to
-- run against a legacy database rather than half-applying — see the preflight
-- block immediately below. On a fresh project it stands alone; 0001_init is
-- retained for the pgvector mood-search path, which is orthogonal to it.
--
-- ── Security posture ───────────────────────────────────────────────────────
-- RLS is enabled on every table and every policy is scoped to auth.uid().
-- There is no "readable by all" policy anywhere: a user reads their own rows,
-- and Duo rows are reachable only by the two members of that room. Community
-- figures are exposed exclusively through public.community_pulse(), which
-- returns aggregates behind a k-anonymity floor and never a user id.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Preflight: refuse to run on the incompatible legacy shape ──────────────

do $preflight$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'swipes' and column_name = 'media_item_id'
  ) then
    raise exception
      'legacy public.swipes detected (media_item_id). This schema keys swipes on (media_id, media_type). Drop the legacy table or apply this to a fresh project.'
      using errcode = '42710';
  end if;
end
$preflight$;

-- No extensions are required. uuid generation uses pg_catalog.gen_random_uuid(),
-- which has been in core PostgreSQL since 13 — pulling in pgcrypto just for it
-- is an avoidable dependency, and one that is not present in every environment
-- this schema gets tested against.

-- ── Enums (create-if-absent; CREATE TYPE has no IF NOT EXISTS) ─────────────

do $enums$
begin
  if not exists (select 1 from pg_type where typname = 'media_kind') then
    create type public.media_kind as enum ('movie', 'tv');
  end if;

  if not exists (select 1 from pg_type where typname = 'swipe_direction') then
    -- 'seen' = already watched: excluded from the deck, mild positive signal.
    create type public.swipe_direction as enum ('like', 'dislike', 'superlike', 'seen');
  end if;

  if not exists (select 1 from pg_type where typname = 'duo_room_status') then
    create type public.duo_room_status as enum ('waiting', 'active', 'finished', 'cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'quest_kind') then
    create type public.quest_kind as enum (
      'swipe',          -- swipe N cards
      'watchlist',      -- save N titles
      'review',         -- write N reviews
      'high_rating',    -- leave a review of >= 4 stars
      'region',         -- save N titles from a specific origin country
      'duo',            -- complete a Duo room
      'mood'            -- run N mood searches
    );
  end if;
end
$enums$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. profiles
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  display_name    text,
  avatar_url      text,
  streak_count    integer not null default 0 check (streak_count >= 0),
  longest_streak  integer not null default 0 check (longest_streak >= 0),
  -- DATE, not timestamptz: a streak is a claim about calendar days, and
  -- comparing instants gets both ends wrong (23:59 -> 00:01 is six minutes but
  -- two days). The client applies the same rule locally; see localDayKey().
  last_swipe_date date,
  cinephile_level integer not null default 1 check (cinephile_level between 1 and 10),
  xp              integer not null default 0 check (xp >= 0),
  taste_profile   jsonb not null default '{}'::jsonb,
  locale          text not null default 'he' check (locale in ('en', 'he')),
  is_premium      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. swipes
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.swipes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  media_id   bigint not null,
  media_type public.media_kind not null,
  direction  public.swipe_direction not null,
  created_at timestamptz not null default now(),
  -- One verdict per title per user. Re-swiping updates rather than appending,
  -- otherwise the deck's "already judged" exclusion set grows without bound.
  unique (user_id, media_id, media_type)
);

create index if not exists swipes_user_idx on public.swipes (user_id, created_at desc);
-- Drives community_pulse(): the aggregate scans by day, not by user.
create index if not exists swipes_pulse_idx
  on public.swipes (created_at desc, media_type, media_id)
  where direction in ('like', 'superlike');

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. watchlist
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.watchlist (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  media_id    bigint not null,
  media_type  public.media_kind not null,
  -- Denormalised on purpose: the watchlist must render offline and before any
  -- TMDB request resolves. These are display fields, never a source of truth.
  title       text not null,
  poster_path text,
  rating      numeric(3, 1) check (rating is null or (rating >= 0 and rating <= 10)),
  added_at    timestamptz not null default now(),
  unique (user_id, media_id, media_type)
);

create index if not exists watchlist_user_idx on public.watchlist (user_id, added_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. reviews
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.reviews (
  id         uuid primary key default pg_catalog.gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  media_id   bigint not null,
  media_type public.media_kind not null,
  rating     integer not null check (rating between 1 and 5),
  comment    text not null check (char_length(comment) between 1 and 2000),
  -- Set by a trigger, never by the client. See public.reviews_flag_profanity.
  is_flagged boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists reviews_user_idx on public.reviews (user_id, created_at desc);
create index if not exists reviews_media_idx on public.reviews (media_type, media_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. duo_rooms
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.duo_rooms (
  id         uuid primary key default pg_catalog.gen_random_uuid(),
  -- Codes are read aloud, so the alphabet excludes O/0/I/1. Generated client
  -- side by generateRoomCode(); the CHECK is what actually enforces the shape.
  room_code  text not null unique check (room_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$'),
  host_id    uuid not null references public.profiles (id) on delete cascade,
  guest_id   uuid references public.profiles (id) on delete set null,
  status     public.duo_room_status not null default 'waiting',
  created_at timestamptz not null default now(),
  check (guest_id is null or guest_id <> host_id)
);

create index if not exists duo_rooms_host_idx on public.duo_rooms (host_id, created_at desc);
create index if not exists duo_rooms_guest_idx on public.duo_rooms (guest_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. duo_matches
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.duo_matches (
  id         bigint generated always as identity primary key,
  room_id    uuid not null references public.duo_rooms (id) on delete cascade,
  media_id   bigint not null,
  media_type public.media_kind not null,
  matched_at timestamptz not null default now(),
  -- Both clients detect the same match independently and both write it (see
  -- useDuoRoom): whoever votes second detects it on send, the other on
  -- receive. The unique constraint is what makes that race idempotent.
  unique (room_id, media_id, media_type)
);

create index if not exists duo_matches_room_idx on public.duo_matches (room_id, matched_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6b. duo_votes
--
-- The vote ledger behind record_duo_vote(). Duo votes are exchanged live over
-- an ephemeral Realtime BROADCAST channel, which is lossy by design (`ack:
-- false`): a dropped packet, or a socket reconnect while a phone was
-- backgrounded, silently loses a vote and with it any match it would have
-- produced. Banking each vote here is what lets the server decide matches from
-- committed state instead of from packets that may never have landed.
--
-- These votes deliberately do NOT go in public.swipes. That table feeds the
-- personal taste vector and the daily quota, and a duo vote is a judgement
-- made on someone else's behalf — routing it there would teach the recommender
-- the wrong thing and burn the user's quota doing it.
--
-- Also deliberately absent from the realtime publication below: ~60 rows per
-- session that only this file's own function ever reads.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.duo_votes (
  room_id    uuid not null references public.duo_rooms (id) on delete cascade,
  voter_id   uuid not null references public.profiles (id) on delete cascade,
  media_id   bigint not null,
  media_type public.media_kind not null,
  liked      boolean not null,
  voted_at   timestamptz not null default now(),
  -- Composite PK rather than a surrogate id: it makes re-voting the same card
  -- an idempotent upsert instead of a duplicate row, which is precisely what
  -- lets a client safely retry a vote it is unsure landed.
  primary key (room_id, voter_id, media_id, media_type)
);

-- The partner lookup in record_duo_vote is a prefix of the primary key, so the
-- PK index already serves it and a second index would earn nothing.

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. daily_quests
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.daily_quests (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  quest_type public.quest_kind not null,
  progress   integer not null default 0 check (progress >= 0),
  goal       integer not null check (goal > 0),
  completed  boolean not null default false,
  -- Local calendar day, supplied by the client. The server cannot derive it:
  -- current_date here is UTC, which would roll a Jerusalem user's quests over
  -- at 02:00 (03:00 in winter) rather than at midnight.
  date       date not null,
  unique (user_id, quest_type, date)
);

create index if not exists daily_quests_user_day_idx on public.daily_quests (user_id, date);

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. mood_searches — Mood Mode query log
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
-- 9. rate_limits — fixed-window counters for Edge Function quotas
--
-- The window length is a PARAMETER of check_rate_limit, not a property of this
-- table, so moving the Mood free tier from an hourly to a daily cap is a
-- one-line change in the Edge Function with no migration.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.rate_limits (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (user_id, bucket, window_start)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- NOT IN THIS FILE: the pgvector layer
--
-- `media_items`, `taste_profiles` and `match_media()` are defined only in
-- supabase/migrations/20260816140000_mood_foundation.sql, and deliberately so.
-- They depend on pgvector, and the harness this file exists to feed (PGlite,
-- see scripts/check-schema.mjs) does not ship it — PGlite 0.5.4 bundles 33
-- contrib extensions and `vector` is not among them, nor is it available as a
-- separate package. Putting a `vector(1536)` column here would make
-- `npm run check:schema` fail at the first CREATE TABLE and cost us the
-- coverage this file provides for everything else.
--
-- That layer is instead validated against the real target engine — live
-- PostgreSQL 17 with pgvector 0.8.2 — inside a rolled-back transaction,
-- including behavioural tests for the match_media anti-join. Strictly better
-- evidence than PGlite for that half; PGlite is a near-match engine, and it
-- cannot execute an HNSW index or a `<=>` operator at all.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- Server-side bilingual profanity filter
--
-- Mirrors src/lib/profanity.ts. The client copy exists for instant feedback;
-- THIS one is the enforcement point, because the client filter is trivially
-- bypassed by anyone willing to open a network tab.
--
-- Matching is WHOLE-TOKEN, never substring — substring matching is the
-- Scunthorpe problem and would silently reject legitimate reviews ("a
-- masterclass in tension"). Both the input and the dictionary pass through the
-- same normaliser, which is what defeats leetspeak without resorting to
-- substrings.
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * Folds text into the comparison space: lowercase, leetspeak resolved, Hebrew
 * final forms folded, non-letters reduced to spaces, repeated characters
 * collapsed. Returns a space-separated token stream.
 */
create or replace function public.profanity_normalize(p_text text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select btrim(
    regexp_replace(
      regexp_replace(
        translate(
          lower(coalesce(p_text, '')),
          -- leetspeak                     hebrew final forms
          '4@8(361!|05$7+2'             || 'ךםןףץ',
          'aabcegiiiossttz'             || 'כמנפצ'
        ),
        -- Anything that is not a Latin or Hebrew letter becomes a separator.
        '[^a-zא-ת]+', ' ', 'g'
      ),
      -- "fuuuuck" and "fuck" must land on the same token. Safe because the
      -- dictionary is collapsed identically and comparison is whole-token.
      '(.)\1+', '\1', 'g'
    )
  );
$fn$;

/** Blocked single words, stored pre-normalised. */
create or replace function public.profanity_terms()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array(
    select public.profanity_normalize(t)
    from unnest(array[
      -- English. Vulgarity and slurs only: "damn" and "hell" occur constantly
      -- in film writing ("a hell of a performance") and blocking them would
      -- make the feature feel broken.
      --
      -- Bare "dick" and "cock" are deliberately absent — "Dick Van Dyke",
      -- "Moby Dick" and "Philip K. Dick" are all things a reviewer will
      -- legitimately type. "dickhead" is unambiguous and stays.
      'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch',
      'cunt', 'asshole', 'dickhead', 'bastard', 'wanker', 'twat', 'prick',
      'slut', 'whore', 'faggot', 'nigger', 'nigga', 'retard', 'retarded',
      'pussy', 'jerkoff', 'douchebag', 'skank',
      -- Hebrew. STARTER LIST — needs a native speaker and a community-policy
      -- owner before launch; Hebrew profanity leans on borrowed Arabic
      -- vulgarities whose register varies a lot by context.
      'זין', 'זיין', 'כוס', 'כוסית', 'שרמוטה', 'זונה', 'מניאק', 'מטומטם',
      'מפגר', 'חרא', 'תחת', 'לזיין', 'מזדיין', 'דפוק', 'אידיוט',
      'אחשרמוטה', 'כוסאמק', 'אמק', 'שרמוטות', 'זבל'
    ]) as t
  );
$fn$;

/** Blocked multi-word phrases, pre-normalised. */
create or replace function public.profanity_phrases()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array(
    select public.profanity_normalize(t)
    from unnest(array[
      'בן זונה', 'בת זונה', 'son of a bitch', 'piece of shit'
    ]) as t
  );
$fn$;

/**
 * Returns every blocked term found in `p_text` (normalised forms, for logging).
 * Empty array = clean.
 */
create or replace function public.profanity_matches(p_text text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  c_hebrew_prefixes constant text := 'והבלכמש';
  v_norm    text := public.profanity_normalize(p_text);
  v_dict    text[] := public.profanity_terms();
  v_phrases text[] := public.profanity_phrases();
  v_tokens  text[];
  v_tok     text;
  v_strip   text;
  v_i       integer;
  v_hits    text[] := '{}';
  v_phrase  text;
  v_run     text := '';
  v_runs    text[] := '{}';
  v_start   integer;
  v_len     integer;
  v_window  text;
begin
  if v_norm = '' then
    return v_hits;
  end if;

  v_tokens := regexp_split_to_array(v_norm, '\s+');

  foreach v_tok in array v_tokens loop
    if char_length(v_tok) >= 2 then
      if v_tok = any (v_dict) then
        v_hits := v_hits || v_tok;
      else
        -- Hebrew glues single-letter prefixes straight onto the noun, and they
        -- STACK: "ו"+"ה" ("and the"), "ש"+"ה" ("that the"). Peeling only one
        -- let "והשרמוטה" through — caught by the assertion suite. Two covers
        -- every common pairing; the remainder must stay >= 3 letters so the
        -- stripping cannot manufacture a short false positive.
        v_strip := v_tok;
        for v_i in 1 .. 2 loop
          exit when char_length(v_strip) < 4
                 or position(left(v_strip, 1) in c_hebrew_prefixes) = 0;
          v_strip := substr(v_strip, 2);
          if v_strip = any (v_dict) then
            v_hits := v_hits || v_strip;
            exit;
          end if;
        end loop;
      end if;
    end if;

    -- Accumulate runs of isolated single letters: "f.u.c.k" tokenises to
    -- four one-character tokens, which is what spacing-out evasion looks
    -- like. Ordinary prose does not produce runs of three or more.
    if char_length(v_tok) = 1 then
      v_run := v_run || v_tok;
    else
      if char_length(v_run) >= 3 then
        v_runs := v_runs || v_run;
      end if;
      v_run := '';
    end if;
  end loop;

  if char_length(v_run) >= 3 then
    v_runs := v_runs || v_run;
  end if;

  -- Every contiguous window of a run, because the evasion may be padded with
  -- unrelated single letters on either side ("f.u.c.k t" from "f.u.c.k this").
  -- Windowing is safe HERE and nowhere else: to reach this point the input had
  -- to already be a run of isolated letters, so "Scunthorpe" can never arrive.
  foreach v_run in array v_runs loop
    v_len := char_length(v_run);
    for v_start in 1 .. v_len - 2 loop
      for v_window in
        select substr(v_run, v_start, w)
        from generate_series(3, v_len - v_start + 1) as w
      loop
        if v_window = any (v_dict) then
          v_hits := v_hits || v_window;
        end if;
      end loop;
    end loop;
  end loop;

  foreach v_phrase in array v_phrases loop
    if v_phrase <> '' and position(' ' || v_phrase || ' ' in ' ' || v_norm || ' ') > 0 then
      v_hits := v_hits || v_phrase;
    end if;
  end loop;

  return array(select distinct unnest(v_hits));
end;
$fn$;

create or replace function public.is_profane(p_text text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select array_length(public.profanity_matches(p_text), 1) is not null;
$fn$;

/**
 * Flags rather than rejects.
 *
 * Rejecting would discard the content and hand an attacker a probe oracle for
 * the dictionary. Flagging keeps the row for moderation while the RLS policies
 * below make it unreadable by anyone but its author — the review is
 * effectively unpublished the moment it is written.
 *
 * is_flagged is recomputed here on every insert and update, so a client that
 * sends `is_flagged: false` by hand cannot launder anything past it.
 */
create or replace function public.reviews_flag_profanity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  new.is_flagged := public.is_profane(new.comment);
  return new;
end;
$fn$;

drop trigger if exists reviews_flag_profanity on public.reviews;
create trigger reviews_flag_profanity
  before insert or update of comment on public.reviews
  for each row execute function public.reviews_flag_profanity();

-- ═══════════════════════════════════════════════════════════════════════════
-- Gamification: levels, XP, streaks, quests
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * XP -> cinephile level (1..10).
 *
 * Thresholds widen as they climb so early levels arrive fast (the first two
 * should land inside a first session) while "Cinephile Legend" stays a genuine
 * long-haul goal. Level NAMES live in the client i18n files, not here — they
 * are user-facing copy and have to exist in Hebrew as well as English.
 */
create or replace function public.cinephile_level(p_xp integer)
returns integer
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_xp >= 6000 then 10
    when p_xp >= 4200 then 9
    when p_xp >= 3000 then 8
    when p_xp >= 2100 then 7
    when p_xp >= 1400 then 6
    when p_xp >= 900  then 5
    when p_xp >= 500  then 4
    when p_xp >= 250  then 3
    when p_xp >= 100  then 2
    else 1
  end;
$fn$;

/** Adds XP and recomputes the level. Returns the new xp/level pair. */
create or replace function public.award_xp(p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user     uuid := auth.uid();
  v_xp       integer;
  v_level    integer;
  v_previous integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  select cinephile_level into v_previous from public.profiles where id = v_user;
  if not found then
    raise exception 'profile_missing' using errcode = 'P0002';
  end if;

  update public.profiles
  set xp = xp + p_amount,
      cinephile_level = public.cinephile_level(xp + p_amount)
  where id = v_user
  returning xp, cinephile_level into v_xp, v_level;

  return jsonb_build_object(
    'xp', v_xp,
    'level', v_level,
    'levelled_up', v_level > v_previous
  );
end;
$fn$;

/**
 * Advances the streak for a local calendar day supplied by the CLIENT.
 *
 * The day has to come from the device: the server's current_date is UTC, and a
 * user in Jerusalem swiping at 01:00 local is still "yesterday" in UTC, which
 * would silently break a streak the user can see is intact. The value is
 * bounded to +/- 1 day of the server's date so it cannot be used to fabricate
 * a streak by claiming an arbitrary date.
 */
create or replace function public.touch_streak(p_local_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user    uuid := auth.uid();
  v_last    date;
  v_current integer;
  v_longest integer;
  v_next    integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_local_date is null or p_local_date not between current_date - 1 and current_date + 1 then
    raise exception 'invalid_local_date' using errcode = '22023';
  end if;

  select last_swipe_date, streak_count, longest_streak
    into v_last, v_current, v_longest
  from public.profiles where id = v_user for update;

  if not found then
    raise exception 'profile_missing' using errcode = 'P0002';
  end if;

  if v_last = p_local_date then
    -- Already counted today. Advancing again would make the streak climb once
    -- per swipe instead of once per day.
    return jsonb_build_object('streak', v_current, 'longest', v_longest, 'advanced', false);
  end if;

  v_next := case when v_last = p_local_date - 1 then v_current + 1 else 1 end;
  v_longest := greatest(v_longest, v_next);

  update public.profiles
  set streak_count = v_next, longest_streak = v_longest, last_swipe_date = p_local_date
  where id = v_user;

  return jsonb_build_object('streak', v_next, 'longest', v_longest, 'advanced', true);
end;
$fn$;

/**
 * Creates the day's quest set if it does not exist yet, then returns it.
 *
 * The client picks WHICH quests (it owns the copy and the day-seed), the server
 * owns progress and completion. Existing rows are never overwritten, so calling
 * this on every launch cannot reset a half-finished day.
 */
create or replace function public.ensure_daily_quests(p_date date, p_quests jsonb)
returns setof public.daily_quests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(p_quests) <> 'array' or jsonb_array_length(p_quests) > 6 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if p_date is null or p_date not between current_date - 1 and current_date + 1 then
    raise exception 'invalid_local_date' using errcode = '22023';
  end if;

  insert into public.daily_quests (user_id, quest_type, progress, goal, completed, date)
  select
    v_user,
    (q ->> 'quest_type')::public.quest_kind,
    0,
    greatest((q ->> 'goal')::integer, 1),
    false,
    p_date
  from jsonb_array_elements(p_quests) q
  on conflict (user_id, quest_type, date) do nothing;

  return query
    select * from public.daily_quests
    where user_id = v_user and date = p_date
    order by quest_type;
end;
$fn$;

/**
 * Adds progress to one quest and awards XP the first time it completes.
 *
 * The completion award is inside the same statement that flips `completed`, so
 * a double-tap or a retried request cannot pay out twice: the second call sees
 * completed = true and the WHERE clause matches nothing.
 */
create or replace function public.advance_quest(
  p_date       date,
  p_quest_type public.quest_kind,
  p_amount     integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c_reward_xp constant integer := 50;
  v_user      uuid := auth.uid();
  v_row       public.daily_quests;
  v_just_done boolean := false;
  v_award     jsonb := null;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;

  update public.daily_quests
  set progress  = least(progress + p_amount, goal),
      completed = (least(progress + p_amount, goal) >= goal)
  where user_id = v_user
    and date = p_date
    and quest_type = p_quest_type
    and completed = false
  returning * into v_row;

  if not found then
    -- Either no such quest today, or it was already finished. Both are
    -- ordinary outcomes, not errors.
    select * into v_row from public.daily_quests
    where user_id = v_user and date = p_date and quest_type = p_quest_type;
    return jsonb_build_object(
      'found', found,
      'completed', coalesce(v_row.completed, false),
      'progress', coalesce(v_row.progress, 0),
      'goal', coalesce(v_row.goal, 0),
      'awarded', null
    );
  end if;

  v_just_done := v_row.completed;
  if v_just_done then
    v_award := public.award_xp(c_reward_xp);
  end if;

  return jsonb_build_object(
    'found', true,
    'completed', v_row.completed,
    'progress', v_row.progress,
    'goal', v_row.goal,
    'awarded', v_award
  );
end;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Duo rooms
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * Joins an open room by code.
 *
 * SECURITY DEFINER because the guest cannot see the room before joining it —
 * an RLS-visible lookup by code would let anyone enumerate rooms and read who
 * is hosting. The function reveals a room only at the moment it admits you to
 * it, and re-joining a room you are already in is an idempotent success so a
 * reconnect does not fail.
 */
create or replace function public.join_duo_room(p_room_code text)
returns public.duo_rooms
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
  v_row  public.duo_rooms;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  update public.duo_rooms
  set guest_id = v_user, status = 'active'
  where room_code = upper(p_room_code)
    and status = 'waiting'
    and guest_id is null
    and host_id <> v_user
  returning * into v_row;

  if not found then
    select * into v_row from public.duo_rooms
    where room_code = upper(p_room_code)
      and (host_id = v_user or guest_id = v_user);
    if not found then
      raise exception 'duo_room_unavailable' using errcode = 'P0002';
    end if;
  end if;

  return v_row;
end;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Duo match detection
--
-- Records one vote and reports whether it completed a match.
--
-- ── Why this is an RPC and not a trigger ──────────────────────────────────
-- A trigger on public.swipes was the obvious-looking option and is wrong twice
-- over: duo votes never reach that table, and they must not (see duo_votes).
-- Recording the vote and deciding the match have to be ONE atomic step, which
-- only the database can offer, so it lives here.
--
-- ── Why the row lock is load-bearing ──────────────────────────────────────
-- Without it this is a textbook write-skew. Two people can like the same card
-- within milliseconds; under READ COMMITTED each transaction inserts its own
-- vote, then looks for the partner's and does NOT see it because the other has
-- not committed — so both conclude "no match" and the one case the feature
-- exists for, simultaneous agreement, is the one case that fails. Locking the
-- room row serialises votes within a room, which costs nothing at two users
-- and guarantees the second voter observes the first's committed vote.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.record_duo_vote(
  p_room_id    uuid,
  p_media_id   bigint,
  p_media_type public.media_kind,
  p_liked      boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user    uuid := auth.uid();
  v_room    public.duo_rooms;
  v_partner uuid;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Serialises the room, and doubles as the membership check: SECURITY
  -- DEFINER bypasses RLS, so this predicate is what stops a caller voting
  -- into a room they are not in.
  select * into v_room
  from public.duo_rooms
  where id = p_room_id
    and (host_id = v_user or guest_id = v_user)
  for update;

  if not found then
    raise exception 'duo_room_forbidden' using errcode = '42501';
  end if;

  insert into public.duo_votes (room_id, voter_id, media_id, media_type, liked)
  values (p_room_id, v_user, p_media_id, p_media_type, p_liked)
  on conflict (room_id, voter_id, media_id, media_type)
  do update set liked = excluded.liked, voted_at = now();

  -- A dislike is still banked (it answers "how far has my partner got") but it
  -- can never create a match.
  if not p_liked then
    return false;
  end if;

  v_partner := case when v_room.host_id = v_user then v_room.guest_id else v_room.host_id end;
  if v_partner is null then
    return false;
  end if;

  if not exists (
    select 1 from public.duo_votes
    where room_id = p_room_id
      and voter_id = v_partner
      and media_id = p_media_id
      and media_type = p_media_type
      and liked
  ) then
    return false;
  end if;

  -- DO NOTHING rather than an error: the other device's client-side detector
  -- may have written this exact row already. The unique key on duo_matches
  -- absorbs the race instead of guarding against it.
  insert into public.duo_matches (room_id, media_id, media_type)
  values (p_room_id, p_media_id, p_media_type)
  on conflict (room_id, media_id, media_type) do nothing;

  return true;
end;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Community pulse (the Discover ticker)
--
-- The ONLY route by which one user learns anything about another, and it is
-- deliberately narrow: aggregate counts, no user ids, no titles (the client
-- already resolves those from TMDB and caches them), and a k-anonymity floor
-- so a count can never describe one identifiable person's viewing.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.community_pulse(
  p_hours integer default 24,
  p_limit integer default 10
)
returns table (
  media_id    bigint,
  media_type  public.media_kind,
  like_count  bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select s.media_id, s.media_type, count(distinct s.user_id) as like_count
  from public.swipes s
  where s.created_at >= now() - make_interval(hours => least(greatest(p_hours, 1), 168))
    and s.direction in ('like', 'superlike')
  group by s.media_id, s.media_type
  -- k-anonymity floor: below three distinct users an "N people liked this"
  -- line stops being a community signal and starts being a report on one
  -- person's evening.
  having count(distinct s.user_id) >= 3
  order by count(distinct s.user_id) desc
  limit least(greatest(p_limit, 1), 50);
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Signup bootstrap + updated_at
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_locale text := new.raw_user_meta_data ->> 'locale';
begin
  if v_locale is null or v_locale not in ('en', 'he') then
    v_locale := 'he';
  end if;

  insert into public.profiles (id, display_name, locale)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(coalesce(new.email, 'viewer'), '@', 1)
    ),
    v_locale
  )
  on conflict (id) do nothing;

  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
--
-- Enabled on all seven tables. Policies are re-created rather than guarded,
-- because CREATE POLICY has no IF NOT EXISTS and a stale policy left behind by
-- an earlier revision is a security bug, not a harmless leftover.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles     enable row level security;
alter table public.swipes       enable row level security;
alter table public.watchlist    enable row level security;
alter table public.reviews      enable row level security;
alter table public.duo_rooms    enable row level security;
alter table public.duo_matches  enable row level security;
alter table public.duo_votes    enable row level security;
alter table public.daily_quests enable row level security;
alter table public.mood_searches enable row level security;
alter table public.rate_limits   enable row level security;

-- ── Why there is deliberately no FORCE ROW LEVEL SECURITY here ─────────────
--
-- FORCE makes policies apply to the table OWNER as well, which sounds strictly
-- safer and is not: it breaks every SECURITY DEFINER function in this file.
-- Those functions exist precisely to perform operations the caller may not do
-- directly — create a profile on signup, write a quest row a client is
-- forbidden to insert, admit a guest to a room they cannot yet see.
--
-- With FORCE on and a non-superuser owner (which is what a hosted Supabase
-- project is), handle_new_user cannot insert into profiles at all, so SIGNUP
-- ITSELF FAILS. Verified: the assertion suite reproduces this by reassigning
-- ownership to a role without BYPASSRLS, and it fails four ways.
--
-- Nothing is given up. FORCE only ever changes behaviour for the owner, and
-- `authenticated`/`anon` are never the owner — every policy below still
-- applies to them in full, which the same suite proves by ownership-reassigned
-- cross-user read/write attempts that are still denied.
alter table public.profiles     no force row level security;
alter table public.swipes       no force row level security;
alter table public.watchlist    no force row level security;
alter table public.reviews      no force row level security;
alter table public.duo_rooms    no force row level security;
alter table public.duo_matches  no force row level security;
alter table public.duo_votes    no force row level security;
alter table public.daily_quests no force row level security;
alter table public.mood_searches no force row level security;
alter table public.rate_limits   no force row level security;

-- ── profiles ───────────────────────────────────────────────────────────────
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT policy: rows are created by the on_auth_user_created trigger.
-- No DELETE policy: profiles die with the auth user, via ON DELETE CASCADE.

-- ── swipes ─────────────────────────────────────────────────────────────────
drop policy if exists "swipes: read own" on public.swipes;
create policy "swipes: read own" on public.swipes
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "swipes: insert own" on public.swipes;
create policy "swipes: insert own" on public.swipes
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "swipes: update own" on public.swipes;
create policy "swipes: update own" on public.swipes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "swipes: delete own" on public.swipes;
create policy "swipes: delete own" on public.swipes
  for delete to authenticated using (user_id = (select auth.uid()));

-- ── watchlist ──────────────────────────────────────────────────────────────
drop policy if exists "watchlist: read own" on public.watchlist;
create policy "watchlist: read own" on public.watchlist
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "watchlist: insert own" on public.watchlist;
create policy "watchlist: insert own" on public.watchlist
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "watchlist: update own" on public.watchlist;
create policy "watchlist: update own" on public.watchlist
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "watchlist: delete own" on public.watchlist;
create policy "watchlist: delete own" on public.watchlist
  for delete to authenticated using (user_id = (select auth.uid()));

-- ── reviews ────────────────────────────────────────────────────────────────
-- Own-rows-only, matching what the UI tells the user ("only you can see
-- this"). Making reviews world-readable is a one-policy change, but it is a
-- product and privacy decision — not something to switch on quietly because
-- the table happens to have a moderation column.
drop policy if exists "reviews: read own" on public.reviews;
create policy "reviews: read own" on public.reviews
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "reviews: insert own" on public.reviews;
create policy "reviews: insert own" on public.reviews
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "reviews: update own" on public.reviews;
create policy "reviews: update own" on public.reviews
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "reviews: delete own" on public.reviews;
create policy "reviews: delete own" on public.reviews
  for delete to authenticated using (user_id = (select auth.uid()));

-- ── duo_rooms ──────────────────────────────────────────────────────────────
-- Membership-scoped. Note there is no "select by code" policy: joining goes
-- through join_duo_room(), so an outsider cannot enumerate rooms.
drop policy if exists "duo rooms: members read" on public.duo_rooms;
create policy "duo rooms: members read" on public.duo_rooms
  for select to authenticated
  using (host_id = (select auth.uid()) or guest_id = (select auth.uid()));

drop policy if exists "duo rooms: host creates" on public.duo_rooms;
create policy "duo rooms: host creates" on public.duo_rooms
  for insert to authenticated with check (host_id = (select auth.uid()));

drop policy if exists "duo rooms: members update" on public.duo_rooms;
create policy "duo rooms: members update" on public.duo_rooms
  for update to authenticated
  using (host_id = (select auth.uid()) or guest_id = (select auth.uid()))
  with check (host_id = (select auth.uid()) or guest_id = (select auth.uid()));

-- ── duo_matches ────────────────────────────────────────────────────────────
drop policy if exists "duo matches: members read" on public.duo_matches;
create policy "duo matches: members read" on public.duo_matches
  for select to authenticated
  using (exists (
    select 1 from public.duo_rooms r
    where r.id = duo_matches.room_id
      and ((select auth.uid()) in (r.host_id, r.guest_id))
  ));

drop policy if exists "duo matches: members insert" on public.duo_matches;
create policy "duo matches: members insert" on public.duo_matches
  for insert to authenticated
  with check (exists (
    select 1 from public.duo_rooms r
    where r.id = duo_matches.room_id
      and ((select auth.uid()) in (r.host_id, r.guest_id))
  ));

-- ── duo_votes ──────────────────────────────────────────────────────────────
-- A client never needs to read these (record_duo_vote does the reasoning
-- server-side), but the policies are written anyway so the table is not a hole
-- if a read path is ever added.
drop policy if exists "duo votes: own insert" on public.duo_votes;
create policy "duo votes: own insert" on public.duo_votes
  for insert to authenticated
  with check (
    voter_id = (select auth.uid())
    and exists (
      select 1 from public.duo_rooms r
      where r.id = duo_votes.room_id
        and ((select auth.uid()) in (r.host_id, r.guest_id))
    )
  );

drop policy if exists "duo votes: own update" on public.duo_votes;
create policy "duo votes: own update" on public.duo_votes
  for update to authenticated
  using (voter_id = (select auth.uid()))
  with check (voter_id = (select auth.uid()));

drop policy if exists "duo votes: members read" on public.duo_votes;
create policy "duo votes: members read" on public.duo_votes
  for select to authenticated
  using (exists (
    select 1 from public.duo_rooms r
    where r.id = duo_votes.room_id
      and ((select auth.uid()) in (r.host_id, r.guest_id))
  ));

-- ── daily_quests ───────────────────────────────────────────────────────────
-- SELECT only. Progress and completion move exclusively through
-- advance_quest(), so a client cannot mark its own quests done and mint XP.
drop policy if exists "quests: read own" on public.daily_quests;
create policy "quests: read own" on public.daily_quests
  for select to authenticated using (user_id = (select auth.uid()));

-- ── mood_searches / rate_limits ────────────────────────────────────────────
-- SELECT only, own rows. Every write goes through an Edge Function holding the
-- service-role key: a client that could insert its own rate_limits row could
-- erase its own quota, and one that could edit the window could reset it.
drop policy if exists "mood searches: read own" on public.mood_searches;
create policy "mood searches: read own" on public.mood_searches
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "rate limits: read own" on public.rate_limits;
create policy "rate limits: read own" on public.rate_limits
  for select to authenticated using (user_id = (select auth.uid()));

-- ═══════════════════════════════════════════════════════════════════════════
-- Account deletion
-- ═══════════════════════════════════════════════════════════════════════════

-- Erases the CALLER's account, irreversibly.
--
-- ── Why this has to be SECURITY DEFINER ───────────────────────────────────
-- `auth.users` lives in a schema the `authenticated` role has no DELETE on,
-- and it should stay that way — a client that can delete rows there can delete
-- anyone's. Running as the definer lets the deletion happen while `auth.uid()`
-- pins it to exactly one row: the caller's own. There is no parameter, so
-- there is nothing to tamper with; the identity comes from the verified JWT.
--
-- ── Why deleting one row is enough ────────────────────────────────────────
-- profiles.id references auth.users ON DELETE CASCADE, and swipes, watchlist,
-- reviews, duo_rooms.host_id and daily_quests all reference profiles ON DELETE
-- CASCADE. Removing the auth row therefore takes the whole graph with it.
-- duo_rooms.guest_id is ON DELETE SET NULL by design: a departing guest must
-- not destroy the host's room.
--
-- `set search_path = ''` is load-bearing on a SECURITY DEFINER function —
-- without it a caller-controlled search_path could shadow `auth.uid()`.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  delete from auth.users where id = v_user;
end;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rate limiting
--
-- Atomic fixed-window counter behind every metered Edge Function.
--
-- Placement matters: this must be defined ABOVE the blanket revoke below.
-- Postgres grants EXECUTE to PUBLIC on every newly created function, so a
-- function added after that revoke would silently stay callable by anyone.
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
as $fn$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  -- Opportunistic cleanup of expired windows for this key, so the table needs
  -- no scheduled reaper.
  delete from public.rate_limits
  where user_id = p_user_id and bucket = p_bucket and window_start < v_window_start;

  -- Increment and read are ONE statement: two concurrent requests cannot both
  -- observe the pre-increment count and both be let through.
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
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Grants
-- ═══════════════════════════════════════════════════════════════════════════

-- `authenticated` MUST be in this revoke.
--
-- Supabase's default privileges grant EXECUTE on every new function in `public`
-- to anon/authenticated/service_role, so revoking from only `public, anon` left
-- signed-in users able to call everything here over `/rest/v1/rpc/...` —
-- including the two TRIGGER functions, which have no business being reachable
-- from the API at all. Supabase's own security linter flagged exactly that.
-- Revoke from all three, then re-grant only the intended entry points.
revoke execute on all functions in schema public from public, anon, authenticated;

-- The RPC surface, and nothing else. Notably absent, on purpose:
--   handle_new_user / reviews_flag_profanity / touch_updated_at
--     — trigger functions; Postgres does not check the caller's EXECUTE
--       privilege when firing a trigger, so they need no grant and must not
--       have one.
--   profanity_normalize / profanity_terms / profanity_phrases /
--   profanity_matches / is_profane
--     — internal to the reviews trigger. The client carries its own copy of
--       the filter for instant feedback, so exposing these would only hand
--       out a way to enumerate the blocklist.
grant execute on function public.cinephile_level(integer)                        to authenticated, anon;
grant execute on function public.award_xp(integer)                               to authenticated;
grant execute on function public.touch_streak(date)                              to authenticated;
grant execute on function public.ensure_daily_quests(date, jsonb)                to authenticated;
grant execute on function public.advance_quest(date, public.quest_kind, integer) to authenticated;
grant execute on function public.join_duo_room(text)                             to authenticated;
grant execute on function public.record_duo_vote(uuid, bigint, public.media_kind, boolean) to authenticated;
grant execute on function public.community_pulse(integer, integer)               to authenticated;
-- Deletes only the caller's own row; `anon` is excluded because there is no
-- caller identity to scope it to.
grant execute on function public.delete_own_account()                            to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Realtime
--
-- Duo rides Postgres changes on these two tables: the guest learns it has been
-- admitted from the duo_rooms UPDATE, and both sides learn about a match from
-- the duo_matches INSERT. Per-message vote traffic goes over an ephemeral
-- broadcast channel instead — see src/lib/duoTransport.realtime.ts — because
-- writing thirty rows per session per person to persist a transient vote would
-- be pure waste.
-- ═══════════════════════════════════════════════════════════════════════════

do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'duo_rooms'
    ) then
      alter publication supabase_realtime add table public.duo_rooms;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'duo_matches'
    ) then
      alter publication supabase_realtime add table public.duo_matches;
    end if;
  end if;
end
$realtime$;

-- Realtime sends a row only if RLS lets the subscriber SELECT it, so the
-- membership policies above are what stop a third party tailing a Duo room.
alter table public.duo_rooms   replica identity full;
alter table public.duo_matches replica identity full;
