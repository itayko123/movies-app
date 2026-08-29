-- Assertions against supabase_schema.sql running on real PostgreSQL 17.
-- Any failure raises, and psql runs with ON_ERROR_STOP=1, so the script aborts.

-- ══ Signup trigger ═════════════════════════════════════════════════════════
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@test.local', '{"display_name":"Alice","locale":"he"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@test.local',   '{"locale":"en"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@test.local', '{}');

do $$
declare n int; v_name text; v_locale text;
begin
  select count(*) into n from public.profiles;
  if n <> 3 then raise exception 'FAIL signup trigger: expected 3 profiles, got %', n; end if;

  select display_name, locale into v_name, v_locale
  from public.profiles where id = '11111111-1111-4111-8111-111111111111';
  if v_name <> 'Alice' then raise exception 'FAIL: display_name not taken from metadata, got %', v_name; end if;
  if v_locale <> 'he' then raise exception 'FAIL: locale not taken from metadata, got %', v_locale; end if;

  -- No locale in metadata must fall back to Hebrew (the app's default).
  select locale into v_locale from public.profiles where id = '33333333-3333-4333-8333-333333333333';
  if v_locale <> 'he' then raise exception 'FAIL: default locale should be he, got %', v_locale; end if;
end $$;
\echo 'PASS  signup trigger creates profiles with metadata + he default'

-- ══ Profanity filter (server side) ═════════════════════════════════════════
do $$
declare
  r record;
  cases constant text[][] := array[
    -- text                                                    , expected
    array['an absolute masterclass in tension'                 , 'f'],
    array['Dick Van Dyke was great in this'                    , 'f'],
    array['the grass was greener and the class was assembled'  , 'f'],
    array['Scunthorpe United: a documentary'                   , 'f'],
    array['סרט מצוין, שיחקו אותה'                              , 'f'],
    array['this movie is fucking terrible'                     , 't'],
    array['what a piece of shit'                               , 't'],
    array['total sh1t direction'                               , 't'],
    array['you are an @sshole'                                 , 't'],
    array['f.u.c.k this movie'                                 , 't'],
    array['fuuuuck this'                                       , 't'],
    array['הסרט הזה חרא'                                       , 't'],
    array['והשרמוטה הזאת'                                      , 't'],
    array['בן זונה של סרט'                                     , 't']
  ];
  i int;
  got boolean;
  want boolean;
begin
  for i in 1 .. array_length(cases, 1) loop
    got  := public.is_profane(cases[i][1]);
    want := cases[i][2]::boolean;
    if got <> want then
      raise exception 'FAIL profanity: % => % (wanted %) matches=%',
        cases[i][1], got, want, public.profanity_matches(cases[i][1]);
    end if;
  end loop;
end $$;
\echo 'PASS  server-side profanity: 14 cases (incl. Scunthorpe + Dick Van Dyke false-positive guards)'

-- ══ Level thresholds ═══════════════════════════════════════════════════════
do $$
begin
  if public.cinephile_level(0)    <> 1  then raise exception 'FAIL level(0)'; end if;
  if public.cinephile_level(99)   <> 1  then raise exception 'FAIL level(99)'; end if;
  if public.cinephile_level(100)  <> 2  then raise exception 'FAIL level(100)'; end if;
  if public.cinephile_level(900)  <> 5  then raise exception 'FAIL level(900)'; end if;
  if public.cinephile_level(5999) <> 9  then raise exception 'FAIL level(5999)'; end if;
  if public.cinephile_level(6000) <> 10 then raise exception 'FAIL level(6000)'; end if;
  if public.cinephile_level(99999)<> 10 then raise exception 'FAIL level cap'; end if;
end $$;
\echo 'PASS  cinephile level thresholds 1..10'

-- ══ RLS: Alice writes her own rows ═════════════════════════════════════════
set role authenticated;
set request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

insert into public.swipes (user_id, media_id, media_type, direction) values
  ('11111111-1111-4111-8111-111111111111', 27205, 'movie', 'like'),
  ('11111111-1111-4111-8111-111111111111', 1399,  'tv',    'superlike');

insert into public.watchlist (user_id, media_id, media_type, title, poster_path, rating) values
  ('11111111-1111-4111-8111-111111111111', 1399, 'tv', 'Game of Thrones', '/poster.jpg', 8.4);

insert into public.reviews (user_id, media_id, media_type, rating, comment) values
  ('11111111-1111-4111-8111-111111111111', 27205, 'movie', 5, 'a masterclass in tension');

do $$
declare n int;
begin
  select count(*) into n from public.swipes;    if n <> 2 then raise exception 'FAIL alice swipes=%', n; end if;
  select count(*) into n from public.watchlist; if n <> 1 then raise exception 'FAIL alice watchlist=%', n; end if;
  select count(*) into n from public.reviews;   if n <> 1 then raise exception 'FAIL alice reviews=%', n; end if;
end $$;
\echo 'PASS  RLS: Alice can write and read her own swipes/watchlist/reviews'

-- ══ Profanity trigger cannot be laundered by the client ════════════════════
insert into public.reviews (user_id, media_id, media_type, rating, comment, is_flagged) values
  ('11111111-1111-4111-8111-111111111111', 550, 'movie', 1, 'this movie is fucking terrible', false);

do $$
declare v_flag boolean;
begin
  select is_flagged into v_flag from public.reviews where media_id = 550;
  if v_flag is not true then
    raise exception 'FAIL: client-supplied is_flagged=false was not overridden by the trigger';
  end if;

  select is_flagged into v_flag from public.reviews where media_id = 27205;
  if v_flag is not false then raise exception 'FAIL: clean review was flagged'; end if;
end $$;
\echo 'PASS  reviews trigger overrides client-supplied is_flagged'

-- ══ RLS: Bob cannot see or touch Alice's rows ══════════════════════════════
set request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

do $$
declare n int;
begin
  select count(*) into n from public.swipes;    if n <> 0 then raise exception 'LEAK: bob sees % swipes', n; end if;
  select count(*) into n from public.watchlist; if n <> 0 then raise exception 'LEAK: bob sees % watchlist rows', n; end if;
  select count(*) into n from public.reviews;   if n <> 0 then raise exception 'LEAK: bob sees % reviews', n; end if;
  select count(*) into n from public.profiles;  if n <> 1 then raise exception 'LEAK: bob sees % profiles (expected only his own)', n; end if;
end $$;
\echo 'PASS  RLS: Bob sees zero of Alice''s swipes/watchlist/reviews, and only his own profile'

do $$
begin
  begin
    insert into public.swipes (user_id, media_id, media_type, direction)
    values ('11111111-1111-4111-8111-111111111111', 99, 'movie', 'like');
    raise exception 'LEAK: bob inserted a swipe owned by alice';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.reviews (user_id, media_id, media_type, rating, comment)
    values ('11111111-1111-4111-8111-111111111111', 99, 'movie', 1, 'impersonation');
    raise exception 'LEAK: bob inserted a review owned by alice';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'PASS  RLS: cross-user INSERT is rejected (42501) for swipes and reviews'

do $$
declare n int;
begin
  update public.profiles set display_name = 'pwned'
  where id = '11111111-1111-4111-8111-111111111111';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'LEAK: bob updated % of alice''s profile rows', n; end if;

  update public.swipes set direction = 'dislike'
  where user_id = '11111111-1111-4111-8111-111111111111';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'LEAK: bob updated % of alice''s swipes', n; end if;

  delete from public.watchlist where user_id = '11111111-1111-4111-8111-111111111111';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'LEAK: bob deleted % of alice''s watchlist rows', n; end if;
end $$;
\echo 'PASS  RLS: cross-user UPDATE/DELETE silently affects zero rows'

-- ══ daily_quests: no client-side INSERT/UPDATE path ════════════════════════
do $$
begin
  begin
    insert into public.daily_quests (user_id, quest_type, progress, goal, completed, date)
    values ('22222222-2222-4222-8222-222222222222', 'swipe', 10, 10, true, current_date);
    raise exception 'LEAK: client minted its own completed quest';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'PASS  RLS: a client cannot INSERT its own (already-completed) quest'

-- ══ Quest lifecycle through the RPCs ═══════════════════════════════════════
select public.ensure_daily_quests(
  current_date,
  '[{"quest_type":"swipe","goal":3},{"quest_type":"watchlist","goal":2}]'::jsonb
);

do $$
declare n int;
begin
  select count(*) into n from public.daily_quests where date = current_date;
  if n <> 2 then raise exception 'FAIL: expected 2 quests, got %', n; end if;
end $$;

-- Idempotent: a second call must not reset progress.
select public.advance_quest(current_date, 'swipe', 2);
select public.ensure_daily_quests(
  current_date,
  '[{"quest_type":"swipe","goal":3},{"quest_type":"watchlist","goal":2}]'::jsonb
);

do $$
declare v_progress int;
begin
  select progress into v_progress from public.daily_quests
  where date = current_date and quest_type = 'swipe';
  if v_progress <> 2 then raise exception 'FAIL: ensure_daily_quests reset progress to %', v_progress; end if;
end $$;
\echo 'PASS  quests: ensure_daily_quests is idempotent and preserves progress'

do $$
declare r1 jsonb; r2 jsonb; v_xp int;
begin
  r1 := public.advance_quest(current_date, 'swipe', 5);   -- completes (2+5 clamped to 3)
  if (r1 ->> 'completed')::boolean is not true then raise exception 'FAIL: quest did not complete: %', r1; end if;
  if (r1 -> 'awarded') = 'null'::jsonb then raise exception 'FAIL: no XP awarded on completion'; end if;
  if (r1 -> 'awarded' ->> 'xp')::int <> 50 then raise exception 'FAIL: expected 50 xp, got %', r1; end if;

  -- Re-completing must not pay out again.
  r2 := public.advance_quest(current_date, 'swipe', 5);
  if (r2 -> 'awarded') <> 'null'::jsonb then raise exception 'FAIL: double payout: %', r2; end if;

  select xp into v_xp from public.profiles where id = '22222222-2222-4222-8222-222222222222';
  if v_xp <> 50 then raise exception 'FAIL: xp should be 50 exactly, got %', v_xp; end if;

  -- progress must clamp to the goal, never exceed it
  if (r2 ->> 'progress')::int <> 3 then raise exception 'FAIL: progress not clamped: %', r2; end if;
end $$;
\echo 'PASS  quests: completion awards 50 XP exactly once (no double payout)'

-- ══ Streaks ════════════════════════════════════════════════════════════════
do $$
declare r jsonb;
begin
  r := public.touch_streak(current_date);
  if (r ->> 'streak')::int <> 1 then raise exception 'FAIL: first day streak=%', r; end if;

  -- Same day again: must not advance.
  r := public.touch_streak(current_date);
  if (r ->> 'advanced')::boolean is not false then raise exception 'FAIL: streak advanced twice in one day: %', r; end if;
  if (r ->> 'streak')::int <> 1 then raise exception 'FAIL: streak climbed within a day: %', r; end if;
end $$;

-- Consecutive day continues; a gap resets but keeps `longest`.
update public.profiles
set last_swipe_date = current_date - 1, streak_count = 6, longest_streak = 6
where id = '22222222-2222-4222-8222-222222222222';

do $$
declare r jsonb;
begin
  r := public.touch_streak(current_date);
  if (r ->> 'streak')::int <> 7 then raise exception 'FAIL: consecutive day should give 7, got %', r; end if;
  if (r ->> 'longest')::int <> 7 then raise exception 'FAIL: longest should track to 7, got %', r; end if;
end $$;

update public.profiles
set last_swipe_date = current_date - 5, streak_count = 7, longest_streak = 12
where id = '22222222-2222-4222-8222-222222222222';

do $$
declare r jsonb;
begin
  r := public.touch_streak(current_date);
  if (r ->> 'streak')::int <> 1 then raise exception 'FAIL: gap should reset to 1, got %', r; end if;
  if (r ->> 'longest')::int <> 12 then raise exception 'FAIL: longest must survive a reset, got %', r; end if;
end $$;

-- A fabricated future date must be rejected outright.
do $$
begin
  begin
    perform public.touch_streak(current_date + 30);
    raise exception 'FAIL: accepted a fabricated future date';
  exception when sqlstate '22023' then null;
  end;
end $$;
\echo 'PASS  streaks: once/day, consecutive continues, gap resets, longest survives, future date rejected'

-- ══ Duo rooms ══════════════════════════════════════════════════════════════
set request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
insert into public.duo_rooms (room_code, host_id) values
  ('ABC234', '11111111-1111-4111-8111-111111111111');

-- The code alphabet is enforced by the DB, not just the client.
do $$
begin
  begin
    insert into public.duo_rooms (room_code, host_id)
    values ('AB01ZZ', '11111111-1111-4111-8111-111111111111');
    raise exception 'FAIL: ambiguous characters 0/1 accepted in a room code';
  exception when check_violation then null;
  end;
end $$;

set request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
do $$
declare n int; v_room public.duo_rooms;
begin
  -- Before joining, the room must be invisible.
  select count(*) into n from public.duo_rooms;
  if n <> 0 then raise exception 'LEAK: bob can see % rooms before joining', n; end if;

  v_room := public.join_duo_room('ABC234');
  if v_room.guest_id <> '22222222-2222-4222-8222-222222222222' then
    raise exception 'FAIL: join did not set guest_id';
  end if;
  if v_room.status <> 'active' then raise exception 'FAIL: join did not activate room'; end if;

  -- Re-joining is an idempotent success (reconnects must not fail).
  v_room := public.join_duo_room('ABC234');

  select count(*) into n from public.duo_rooms;
  if n <> 1 then raise exception 'FAIL: bob should see 1 room after joining, sees %', n; end if;
end $$;
\echo 'PASS  duo: room hidden before join, join_duo_room admits guest, re-join idempotent'

-- Both members may write matches; the unique constraint absorbs the race.
insert into public.duo_matches (room_id, media_id, media_type)
  select id, 27205, 'movie' from public.duo_rooms where room_code = 'ABC234';
insert into public.duo_matches (room_id, media_id, media_type)
  select id, 27205, 'movie' from public.duo_rooms where room_code = 'ABC234'
  on conflict (room_id, media_id, media_type) do nothing;

do $$
declare n int;
begin
  select count(*) into n from public.duo_matches;
  if n <> 1 then raise exception 'FAIL: duplicate match rows: %', n; end if;
end $$;

-- Carol is in neither seat and must see nothing.
set request.jwt.claims = '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.duo_rooms;   if n <> 0 then raise exception 'LEAK: carol sees % duo rooms', n; end if;
  select count(*) into n from public.duo_matches; if n <> 0 then raise exception 'LEAK: carol sees % duo matches', n; end if;

  begin
    perform public.join_duo_room('ABC234');
    raise exception 'LEAK: carol joined a full room';
  exception when sqlstate 'P0002' then null;
  end;
end $$;
\echo 'PASS  duo: non-member sees nothing and cannot join a full room'

-- ══ community_pulse k-anonymity ════════════════════════════════════════════
reset role;
reset request.jwt.claims;

-- Two distinct users like 27205 (alice already did; add bob).
insert into public.swipes (user_id, media_id, media_type, direction) values
  ('22222222-2222-4222-8222-222222222222', 27205, 'movie', 'like');

do $$
declare n int;
begin
  select count(*) into n from public.community_pulse(24, 10) where media_id = 27205;
  if n <> 0 then raise exception 'LEAK: 2 users passed the k-anonymity floor'; end if;
end $$;

insert into public.swipes (user_id, media_id, media_type, direction) values
  ('33333333-3333-4333-8333-333333333333', 27205, 'movie', 'like');

do $$
declare v_count bigint;
begin
  select like_count into v_count from public.community_pulse(24, 10) where media_id = 27205;
  if v_count is null then raise exception 'FAIL: 3 users did not clear the k-anonymity floor'; end if;
  if v_count <> 3 then raise exception 'FAIL: expected like_count 3, got %', v_count; end if;
end $$;
\echo 'PASS  community_pulse: suppressed at 2 distinct users, reported at 3'

-- ══ Realtime wiring ════════════════════════════════════════════════════════
do $$
declare n int;
begin
  select count(*) into n from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename in ('duo_rooms', 'duo_matches');
  if n <> 2 then raise exception 'FAIL: expected 2 realtime tables, got %', n; end if;
end $$;
\echo 'PASS  realtime: duo_rooms + duo_matches are in the supabase_realtime publication'

-- ══ check_rate_limit: the counter behind every metered Edge Function ═══════
--
-- Worth testing rather than merely applying: this function is the only thing
-- standing between a free-tier user and unbounded Claude spend, and its
-- correctness rests on the increment and the read being one atomic statement.
do $$
declare
  v_alice uuid := '11111111-1111-4111-8111-111111111111';
  r jsonb;
begin
  -- Two calls inside a max of 2 are allowed; the third is not.
  r := public.check_rate_limit(v_alice, 'mood', 2, 3600);
  if (r->>'allowed')::boolean is not true then
    raise exception 'FAIL: first call under the cap was blocked (%)', r;
  end if;
  if (r->>'remaining')::int <> 1 then
    raise exception 'FAIL: remaining after 1 of 2 should be 1, got %', r->>'remaining';
  end if;

  r := public.check_rate_limit(v_alice, 'mood', 2, 3600);
  if (r->>'allowed')::boolean is not true then
    raise exception 'FAIL: second call at the cap was blocked (%)', r;
  end if;

  r := public.check_rate_limit(v_alice, 'mood', 2, 3600);
  if (r->>'allowed')::boolean is not false then
    raise exception 'FAIL: third call over the cap was ALLOWED (%)', r;
  end if;
  if (r->>'remaining')::int <> 0 then
    raise exception 'FAIL: remaining over the cap should be 0, got %', r->>'remaining';
  end if;
  if (r->>'retry_after_seconds')::int <= 0 then
    raise exception 'FAIL: retry_after_seconds should be positive, got %', r->>'retry_after_seconds';
  end if;

  -- Buckets are independent — exhausting mood must not throttle embed-media.
  r := public.check_rate_limit(v_alice, 'embed-media', 2, 3600);
  if (r->>'allowed')::boolean is not true then
    raise exception 'FAIL: a separate bucket was throttled by another (%)', r;
  end if;
end $$;
\echo 'PASS  check_rate_limit: allows to the cap, blocks past it, buckets independent'

-- ══ check_rate_limit is not reachable from a client ════════════════════════
--
-- It INCREMENTS on call, so an exposed grant would let anyone burn their own
-- quota — or another user's, since the user id is a parameter.
do $$
begin
  if has_function_privilege('anon',
       'public.check_rate_limit(uuid,text,integer,integer)', 'execute') then
    raise exception 'LEAK: anon can execute check_rate_limit';
  end if;
  if has_function_privilege('authenticated',
       'public.check_rate_limit(uuid,text,integer,integer)', 'execute') then
    raise exception 'LEAK: authenticated can execute check_rate_limit';
  end if;
end $$;
\echo 'PASS  check_rate_limit is service-role only (anon + authenticated revoked)'

-- ══ Coverage: every table has RLS on and at least one policy ═══════════════
--
-- ENUMERATED, not listed. This previously hardcoded the seven table names it
-- knew about, which meant the check silently stopped covering the schema the
-- moment an eighth table was added — it went on reporting PASS while the new
-- table was never examined at all. duo_votes was added and escaped it exactly
-- that way. A coverage assertion that has to be manually kept in step with the
-- thing it covers is not a coverage assertion.
--
-- The floor below is the second half of the guard: if the query itself ever
-- breaks and matches nothing, an empty loop would also "pass".
do $$
declare
  r record;
  v_seen int := 0;
begin
  for r in
    select c.relname, c.relrowsecurity,
           (select count(*) from pg_policies p
             where p.schemaname = 'public' and p.tablename = c.relname) as policies
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r'
  loop
    v_seen := v_seen + 1;
    if not r.relrowsecurity then raise exception 'FAIL: RLS disabled on %', r.relname; end if;
    if r.policies = 0 then raise exception 'FAIL: no policies on %', r.relname; end if;
  end loop;

  if v_seen < 8 then
    raise exception 'FAIL: expected at least 8 public tables, enumerated only %', v_seen;
  end if;

  raise notice 'coverage: % public tables checked', v_seen;
end $$;
\echo 'PASS  every public table has RLS enabled with at least one policy'
