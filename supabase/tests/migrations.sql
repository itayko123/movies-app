-- ══ Tests for the PENDING migrations ══════════════════════════════════════
--
-- These cover the two Phase 6 migrations that `npx supabase db push` is about
-- to apply to production: `delete_own_account` and the Duo match engine. Both
-- are currently 404 in the live project, so this is the last gate before they
-- ship.
--
-- `20260816140000_mood_foundation.sql` is deliberately NOT exercised here — it
-- depends on pgvector, which PGlite does not ship. That migration was validated
-- against real PostgreSQL 17 with pgvector 0.8.2 inside a rolled-back
-- transaction instead. See the note in supabase_schema.sql.

-- ── Fixtures ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@test.local'),
  ('22222222-2222-4222-8222-222222222222', 'bob@test.local'),
  ('33333333-3333-4333-8333-333333333333', 'carol@test.local')
on conflict (id) do nothing;

insert into public.profiles (id, display_name) values
  ('11111111-1111-4111-8111-111111111111', 'Alice'),
  ('22222222-2222-4222-8222-222222222222', 'Bob'),
  ('33333333-3333-4333-8333-333333333333', 'Carol')
on conflict (id) do nothing;

insert into public.duo_rooms (id, room_code, host_id, guest_id, status) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ABC234',
   '11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222', 'active')
on conflict (id) do nothing;

\echo 'PASS  fixtures: two profiles in a shared duo room, one outsider'

-- ══ delete_own_account: exists, and is reachable by exactly the right role ══
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'delete_own_account'
  ) then
    raise exception 'MISSING: delete_own_account was not created';
  end if;

  -- The store-review blocker. It must be callable by a signed-in user...
  if not has_function_privilege('authenticated', 'public.delete_own_account()', 'execute') then
    raise exception 'FAIL: authenticated cannot execute delete_own_account';
  end if;
  -- ...and by nobody else. It deletes an auth.users row.
  if has_function_privilege('anon', 'public.delete_own_account()', 'execute') then
    raise exception 'LEAK: anon can execute delete_own_account';
  end if;
end $$;
\echo 'PASS  delete_own_account exists, granted to authenticated, denied to anon'

-- ══ delete_own_account actually cascades ═══════════════════════════════════
-- Asserting the grant proves the button is callable. It does not prove the
-- account is gone, which is the thing the app stores actually require.
do $$
declare
  v_carol uuid := '33333333-3333-4333-8333-333333333333';
begin
  insert into public.swipes (user_id, media_id, media_type, direction)
  values (v_carol, 550, 'movie', 'like')
  on conflict do nothing;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_carol)::text, true);

  perform public.delete_own_account();

  reset role;

  if exists (select 1 from auth.users where id = v_carol) then
    raise exception 'FAIL: auth.users row survived delete_own_account';
  end if;
  if exists (select 1 from public.profiles where id = v_carol) then
    raise exception 'FAIL: profile survived — the cascade from auth.users is broken';
  end if;
  if exists (select 1 from public.swipes where user_id = v_carol) then
    raise exception 'FAIL: swipes survived — the cascade did not reach child rows';
  end if;
end $$;
\echo 'PASS  delete_own_account removes the auth user and cascades to profile + swipes'

-- ══ delete_own_account refuses an anonymous caller ═════════════════════════
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.delete_own_account();
    reset role;
    raise exception 'FAIL: delete_own_account ran with no auth.uid()';
  exception
    when sqlstate '28000' then
      reset role; -- expected: not_authenticated
  end;
end $$;
\echo 'PASS  delete_own_account raises not_authenticated when auth.uid() is null'

-- ══ duo_votes: RLS is on and policied ══════════════════════════════════════
do $$
declare
  v_policies integer;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'duo_votes' and c.relrowsecurity
  ) then
    raise exception 'FAIL: duo_votes exists without RLS enabled';
  end if;

  select count(*) into v_policies from pg_policies
  where schemaname = 'public' and tablename = 'duo_votes';
  if v_policies < 3 then
    raise exception 'FAIL: duo_votes has % policies, expected 3', v_policies;
  end if;

  -- FORCE would break record_duo_vote, which is SECURITY DEFINER.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'duo_votes' and c.relforcerowsecurity
  ) then
    raise exception 'FAIL: duo_votes has FORCE RLS — it will break the RPC';
  end if;
end $$;
\echo 'PASS  duo_votes: RLS enabled, 3 policies, FORCE correctly off'

-- ══ THE RACE THIS FUNCTION EXISTS FOR: mutual like creates exactly one match ══
do $$
declare
  v_room  uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_alice uuid := '11111111-1111-4111-8111-111111111111';
  v_bob   uuid := '22222222-2222-4222-8222-222222222222';
  v_first boolean;
  v_second boolean;
  v_matches integer;
begin
  set local role authenticated;

  -- Alice likes first. No partner vote yet, so no match.
  perform set_config('request.jwt.claims', json_build_object('sub', v_alice)::text, true);
  v_first := public.record_duo_vote(v_room, 603, 'movie', true);
  if v_first then
    raise exception 'FAIL: a match was declared on one vote';
  end if;

  -- Bob likes the same title. THIS is the call that must return true.
  perform set_config('request.jwt.claims', json_build_object('sub', v_bob)::text, true);
  v_second := public.record_duo_vote(v_room, 603, 'movie', true);
  if not v_second then
    raise exception 'FAIL: mutual like did not produce a match';
  end if;

  reset role;

  select count(*) into v_matches from public.duo_matches
  where room_id = v_room and media_id = 603 and media_type = 'movie';
  if v_matches <> 1 then
    raise exception 'FAIL: expected exactly 1 match row, found %', v_matches;
  end if;
end $$;
\echo 'PASS  record_duo_vote: mutual like creates exactly one duo_matches row'

-- ══ A dislike can never match, and re-voting is idempotent ═════════════════
do $$
declare
  v_room  uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_alice uuid := '11111111-1111-4111-8111-111111111111';
  v_bob   uuid := '22222222-2222-4222-8222-222222222222';
  v_votes integer;
begin
  set local role authenticated;

  perform set_config('request.jwt.claims', json_build_object('sub', v_alice)::text, true);
  perform public.record_duo_vote(v_room, 604, 'movie', true);

  perform set_config('request.jwt.claims', json_build_object('sub', v_bob)::text, true);
  if public.record_duo_vote(v_room, 604, 'movie', false) then
    raise exception 'FAIL: a dislike produced a match';
  end if;

  -- Bob changes his mind. The composite PK must UPDATE, not duplicate.
  if not public.record_duo_vote(v_room, 604, 'movie', true) then
    raise exception 'FAIL: flipping a dislike to a like did not match';
  end if;

  reset role;

  select count(*) into v_votes from public.duo_votes
  where room_id = v_room and voter_id = v_bob and media_id = 604;
  if v_votes <> 1 then
    raise exception 'FAIL: re-voting created % rows, expected 1 (upsert)', v_votes;
  end if;
end $$;
\echo 'PASS  record_duo_vote: dislike never matches, re-voting upserts rather than duplicates'

-- ══ A non-member cannot vote into someone else's room ══════════════════════
-- SECURITY DEFINER bypasses RLS, so the membership predicate inside the
-- function is the ONLY thing standing between an outsider and a stranger's
-- room. If this test ever goes quiet, that door is open.
do $$
declare
  v_room     uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_outsider uuid := '44444444-4444-4444-8444-444444444444';
begin
  insert into auth.users (id, email) values (v_outsider, 'mallory@test.local')
  on conflict (id) do nothing;
  insert into public.profiles (id, display_name) values (v_outsider, 'Mallory')
  on conflict (id) do nothing;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider)::text, true);
  begin
    perform public.record_duo_vote(v_room, 605, 'movie', true);
    reset role;
    raise exception 'BREACH: a non-member voted into another pair''s room';
  exception
    when sqlstate '42501' then
      reset role; -- expected: duo_room_forbidden
  end;
end $$;
\echo 'PASS  record_duo_vote: a non-member is refused with duo_room_forbidden'

-- ══ record_duo_vote grants ═════════════════════════════════════════════════
do $$
begin
  if not has_function_privilege('authenticated',
       'public.record_duo_vote(uuid,bigint,public.media_kind,boolean)', 'execute') then
    raise exception 'FAIL: authenticated cannot execute record_duo_vote';
  end if;
  if has_function_privilege('anon',
       'public.record_duo_vote(uuid,bigint,public.media_kind,boolean)', 'execute') then
    raise exception 'LEAK: anon can execute record_duo_vote';
  end if;
end $$;
\echo 'PASS  record_duo_vote: granted to authenticated, denied to anon'
