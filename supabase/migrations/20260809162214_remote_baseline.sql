-- ===========================================================================
-- REMOTE BASELINE — reconstructed from the live CineSwipe project
-- project ref : dpnwjjjvyvnwlhfbzstb
-- captured    : 2026-08-16
--
-- WHY THIS FILE EXISTS
-- -------------------
-- The live database was built by six migrations applied directly to Supabase
-- (cineswipe_run4_01..06). None of them were ever committed. The only file in
-- this repo was `0001_init.sql`, which described an ENTIRELY DIFFERENT and
-- abandoned v1 schema (duo_sessions, media_items, taste_profiles, pgvector,
-- apply_swipe, match_media …). A `supabase db reset` against it would have
-- built a different application. That file now sits in `supabase/legacy/`
-- marked ABANDONED so nobody builds against it again.
--
-- WHY THE FILENAME IS 20260809162214
-- ----------------------------------
-- That is the HEAD of the remote migration history (`cineswipe_run4_06`).
-- Naming the baseline after a version the remote already records as applied
-- means the CLI's local head matches the remote head, so `supabase db push`
-- has nothing to do and CANNOT re-run any of this against production data.
-- The five earlier remote versions have no local file; that is a cosmetic
-- history gap, not a hazard.
--
-- HOW IT WAS PRODUCED, AND ITS STATUS
-- -----------------------------------
-- Reconstructed from pg_catalog: `pg_get_functiondef` for every function
-- (so bodies are byte-exact, not paraphrased), plus pg_constraint, pg_indexes,
-- pg_policies and pg_publication_tables for the rest. `supabase db dump`
-- was not available — the project is not linked and no database password or
-- service-role key is present in this checkout.
--
-- => Treat this as a REVIEWED SNAPSHOT, not a machine-verified dump. The
--    authoritative regeneration is `supabase link` + `supabase db pull`;
--    diff that output against this file before trusting either. See the
--    commands in the Phase 6 Step 0 report.
--
-- Everything below is written idempotently so re-running it against the live
-- database is a no-op rather than a rebuild.
-- ===========================================================================

-- ── Extensions ─────────────────────────────────────────────────────────────
-- Present live: pgcrypto (gen_random_uuid), uuid-ossp, pg_stat_statements,
-- supabase_vault, plpgsql. Only the one the schema actually depends on is
-- asserted here.
create extension if not exists pgcrypto with schema extensions;

-- ── Enum types ─────────────────────────────────────────────────────────────
do $$ begin
  create type public.media_kind as enum ('movie', 'tv');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.swipe_direction as enum ('like', 'dislike', 'superlike', 'seen');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.duo_room_status as enum ('waiting', 'active', 'finished', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.quest_kind as enum
    ('swipe', 'watchlist', 'review', 'high_rating', 'region', 'duo', 'mood');
exception when duplicate_object then null; end $$;

-- ── Tables ─────────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  display_name    text,
  avatar_url      text,
  streak_count    integer     not null default 0 check (streak_count >= 0),
  longest_streak  integer     not null default 0 check (longest_streak >= 0),
  last_swipe_date date,
  cinephile_level integer     not null default 1
                              check (cinephile_level >= 1 and cinephile_level <= 10),
  xp              integer     not null default 0 check (xp >= 0),
  taste_profile   jsonb       not null default '{}'::jsonb,
  locale          text        not null default 'he' check (locale in ('en', 'he')),
  is_premium      boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.swipes (
  id         bigint generated always as identity primary key,
  user_id    uuid                  not null references public.profiles(id) on delete cascade,
  media_id   bigint                not null,
  media_type public.media_kind     not null,
  direction  public.swipe_direction not null,
  created_at timestamptz           not null default now(),
  unique (user_id, media_id, media_type)
);

create table if not exists public.watchlist (
  id          bigint generated always as identity primary key,
  user_id     uuid              not null references public.profiles(id) on delete cascade,
  media_id    bigint            not null,
  media_type  public.media_kind not null,
  title       text              not null,
  poster_path text,
  rating      numeric(3,1) check (rating is null or (rating >= 0 and rating <= 10)),
  added_at    timestamptz       not null default now(),
  unique (user_id, media_id, media_type)
);

create table if not exists public.reviews (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid              not null references public.profiles(id) on delete cascade,
  media_id   bigint            not null,
  media_type public.media_kind not null,
  rating     integer           not null check (rating >= 1 and rating <= 5),
  comment    text              not null
             check (char_length(comment) >= 1 and char_length(comment) <= 2000),
  is_flagged boolean           not null default false,
  created_at timestamptz       not null default now()
);

create table if not exists public.duo_rooms (
  id         uuid primary key default gen_random_uuid(),
  room_code  text                    not null unique
             -- Crockford-ish alphabet: no O/0, I/1, L to misread aloud.
             check (room_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$'),
  host_id    uuid                    not null references public.profiles(id) on delete cascade,
  guest_id   uuid                    references public.profiles(id) on delete set null,
  status     public.duo_room_status  not null default 'waiting',
  created_at timestamptz             not null default now(),
  check (guest_id is null or guest_id <> host_id)
);

create table if not exists public.duo_matches (
  id         bigint generated always as identity primary key,
  room_id    uuid              not null references public.duo_rooms(id) on delete cascade,
  media_id   bigint            not null,
  media_type public.media_kind not null,
  matched_at timestamptz       not null default now(),
  unique (room_id, media_id, media_type)
);

create table if not exists public.daily_quests (
  id         bigint generated always as identity primary key,
  user_id    uuid              not null references public.profiles(id) on delete cascade,
  quest_type public.quest_kind not null,
  progress   integer           not null default 0 check (progress >= 0),
  goal       integer           not null check (goal > 0),
  completed  boolean           not null default false,
  date       date              not null,
  unique (user_id, quest_type, date)
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create index if not exists swipes_user_idx      on public.swipes (user_id, created_at desc);
-- Partial: the community pulse only ever reads positive verdicts.
create index if not exists swipes_pulse_idx     on public.swipes (created_at desc, media_type, media_id)
  where direction in ('like', 'superlike');
create index if not exists watchlist_user_idx   on public.watchlist (user_id, added_at desc);
create index if not exists reviews_user_idx     on public.reviews (user_id, created_at desc);
create index if not exists reviews_media_idx    on public.reviews (media_type, media_id, created_at desc);
create index if not exists duo_rooms_host_idx   on public.duo_rooms (host_id, created_at desc);
create index if not exists duo_rooms_guest_idx  on public.duo_rooms (guest_id, created_at desc);
create index if not exists duo_matches_room_idx on public.duo_matches (room_id, matched_at desc);
create index if not exists daily_quests_user_day_idx on public.daily_quests (user_id, date);

-- ── Functions ──────────────────────────────────────────────────────────────
-- Bodies below are verbatim `pg_get_functiondef` output from the live project.
--
-- NOTE ON `SET search_path TO ''`: every function pins an empty search_path
-- and fully qualifies its references. That is deliberate — an unpinned
-- search_path on a SECURITY DEFINER function is a privilege-escalation vector.
--
-- NOTE ON FORCE RLS: no table uses FORCE ROW LEVEL SECURITY, and it must stay
-- that way. Forcing RLS applies policies to the table OWNER too, which breaks
-- every SECURITY DEFINER function here — and a superuser-only test will not
-- catch it, because superusers bypass RLS regardless.

CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.profanity_normalize(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select btrim(
    regexp_replace(
      regexp_replace(
        translate(
          lower(coalesce(p_text, '')),
          '4@8(361!|05$7+2'             || 'ךםןףץ',
          'aabcegiiiossttz'             || 'כמנפצ'
        ),
        '[^a-zא-ת]+', ' ', 'g'
      ),
      '(.)\1+', '\1', 'g'
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.profanity_terms()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select array(
    select public.profanity_normalize(t)
    from unnest(array[
      'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch',
      'cunt', 'asshole', 'dickhead', 'bastard', 'wanker', 'twat', 'prick',
      'slut', 'whore', 'faggot', 'nigger', 'nigga', 'retard', 'retarded',
      'pussy', 'jerkoff', 'douchebag', 'skank',
      'זין', 'זיין', 'כוס', 'כוסית', 'שרמוטה', 'זונה', 'מניאק', 'מטומטם',
      'מפגר', 'חרא', 'תחת', 'לזיין', 'מזדיין', 'דפוק', 'אידיוט',
      'אחשרמוטה', 'כוסאמק', 'אמק', 'שרמוטות', 'זבל'
    ]) as t
  );
$function$;

CREATE OR REPLACE FUNCTION public.profanity_phrases()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select array(
    select public.profanity_normalize(t)
    from unnest(array[
      'בן זונה', 'בת זונה', 'son of a bitch', 'piece of shit'
    ]) as t
  );
$function$;

CREATE OR REPLACE FUNCTION public.profanity_matches(p_text text)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.is_profane(p_text text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select array_length(public.profanity_matches(p_text), 1) is not null;
$function$;

CREATE OR REPLACE FUNCTION public.reviews_flag_profanity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  new.is_flagged := public.is_profane(new.comment);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cinephile_level(p_xp integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.award_xp(p_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.touch_streak(p_local_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    return jsonb_build_object('streak', v_current, 'longest', v_longest, 'advanced', false);
  end if;

  v_next := case when v_last = p_local_date - 1 then v_current + 1 else 1 end;
  v_longest := greatest(v_longest, v_next);

  update public.profiles
  set streak_count = v_next, longest_streak = v_longest, last_swipe_date = p_local_date
  where id = v_user;

  return jsonb_build_object('streak', v_next, 'longest', v_longest, 'advanced', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.ensure_daily_quests(p_date date, p_quests jsonb)
 RETURNS SETOF public.daily_quests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.advance_quest(p_date date, p_quest_type public.quest_kind, p_amount integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.join_duo_room(p_room_code text)
 RETURNS public.duo_rooms
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.community_pulse(p_hours integer DEFAULT 24, p_limit integer DEFAULT 10)
 RETURNS TABLE(media_id bigint, media_type public.media_kind, like_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.media_id, s.media_type, count(distinct s.user_id) as like_count
  from public.swipes s
  where s.created_at >= now() - make_interval(hours => least(greatest(p_hours, 1), 168))
    and s.direction in ('like', 'superlike')
  group by s.media_id, s.media_type
  having count(distinct s.user_id) >= 3
  order by count(distinct s.user_id) desc
  limit least(greatest(p_limit, 1), 50);
$function$;

-- ── Triggers ───────────────────────────────────────────────────────────────
drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists reviews_flag_profanity on public.reviews;
create trigger reviews_flag_profanity
  before insert or update of comment on public.reviews
  for each row execute function public.reviews_flag_profanity();

-- Fires on auth.users, so it lives outside the public schema.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Row level security ─────────────────────────────────────────────────────
-- `(select auth.uid())` rather than a bare `auth.uid()` in every policy: the
-- scalar-subquery form is evaluated ONCE per statement instead of once per
-- row, which is the difference between an index scan and a seq scan on
-- swipes.
alter table public.profiles     enable row level security;
alter table public.swipes       enable row level security;
alter table public.watchlist    enable row level security;
alter table public.reviews      enable row level security;
alter table public.duo_rooms    enable row level security;
alter table public.duo_matches  enable row level security;
alter table public.daily_quests enable row level security;

drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: read own"   on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "swipes: read own"   on public.swipes;
drop policy if exists "swipes: insert own" on public.swipes;
drop policy if exists "swipes: update own" on public.swipes;
drop policy if exists "swipes: delete own" on public.swipes;
create policy "swipes: read own"   on public.swipes for select to authenticated
  using (user_id = (select auth.uid()));
create policy "swipes: insert own" on public.swipes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "swipes: update own" on public.swipes for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "swipes: delete own" on public.swipes for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "watchlist: read own"   on public.watchlist;
drop policy if exists "watchlist: insert own" on public.watchlist;
drop policy if exists "watchlist: update own" on public.watchlist;
drop policy if exists "watchlist: delete own" on public.watchlist;
create policy "watchlist: read own"   on public.watchlist for select to authenticated
  using (user_id = (select auth.uid()));
create policy "watchlist: insert own" on public.watchlist for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "watchlist: update own" on public.watchlist for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "watchlist: delete own" on public.watchlist for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "reviews: read own"   on public.reviews;
drop policy if exists "reviews: insert own" on public.reviews;
drop policy if exists "reviews: update own" on public.reviews;
drop policy if exists "reviews: delete own" on public.reviews;
create policy "reviews: read own"   on public.reviews for select to authenticated
  using (user_id = (select auth.uid()));
create policy "reviews: insert own" on public.reviews for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "reviews: update own" on public.reviews for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "reviews: delete own" on public.reviews for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "duo rooms: host creates"   on public.duo_rooms;
drop policy if exists "duo rooms: members read"   on public.duo_rooms;
drop policy if exists "duo rooms: members update" on public.duo_rooms;
create policy "duo rooms: host creates" on public.duo_rooms for insert to authenticated
  with check (host_id = (select auth.uid()));
create policy "duo rooms: members read" on public.duo_rooms for select to authenticated
  using (host_id = (select auth.uid()) or guest_id = (select auth.uid()));
create policy "duo rooms: members update" on public.duo_rooms for update to authenticated
  using (host_id = (select auth.uid()) or guest_id = (select auth.uid()))
  with check (host_id = (select auth.uid()) or guest_id = (select auth.uid()));

drop policy if exists "duo matches: members read"   on public.duo_matches;
drop policy if exists "duo matches: members insert" on public.duo_matches;
create policy "duo matches: members read" on public.duo_matches for select to authenticated
  using (exists (
    select 1 from public.duo_rooms r
    where r.id = duo_matches.room_id
      and ((select auth.uid()) = r.host_id or (select auth.uid()) = r.guest_id)
  ));
create policy "duo matches: members insert" on public.duo_matches for insert to authenticated
  with check (exists (
    select 1 from public.duo_rooms r
    where r.id = duo_matches.room_id
      and ((select auth.uid()) = r.host_id or (select auth.uid()) = r.guest_id)
  ));

-- Read-only to the client on purpose: quests are created and advanced only
-- through ensure_daily_quests / advance_quest, so a client cannot invent a
-- completed quest and collect the XP.
drop policy if exists "quests: read own" on public.daily_quests;
create policy "quests: read own" on public.daily_quests for select to authenticated
  using (user_id = (select auth.uid()));

-- ── Function grants ────────────────────────────────────────────────────────
-- Default EXECUTE for PUBLIC is revoked and re-granted per function. The
-- profanity helpers and the trigger functions are deliberately NOT callable
-- by clients — exposing profanity_terms() would hand out the blocklist, and
-- exposing the trigger bodies serves no client purpose.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.cinephile_level(integer)                          to anon, authenticated;
grant execute on function public.award_xp(integer)                                 to authenticated;
grant execute on function public.touch_streak(date)                                to authenticated;
grant execute on function public.ensure_daily_quests(date, jsonb)                  to authenticated;
grant execute on function public.advance_quest(date, public.quest_kind, integer)   to authenticated;
grant execute on function public.join_duo_room(text)                               to authenticated;
grant execute on function public.community_pulse(integer, integer)                 to authenticated;

-- ── Realtime ───────────────────────────────────────────────────────────────
-- Duo is the only live-collaborative surface, so only its two tables are
-- published. Adding swipes here would broadcast every user's activity.
do $$ begin
  alter publication supabase_realtime add table public.duo_rooms;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.duo_matches;
exception when duplicate_object then null; end $$;
