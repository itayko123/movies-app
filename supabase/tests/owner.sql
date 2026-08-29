-- Does the schema still work when the table owner is NOT a superuser?
--
-- This matters because PGlite (and a local `supabase start`) run as a
-- superuser, and superusers bypass RLS unconditionally — which would hide a
-- FORCE ROW LEVEL SECURITY misconfiguration until it reached production.
-- Reassigning ownership to a plain role with no BYPASSRLS reproduces the
-- worst-case hosted setup, where every SECURITY DEFINER function is subject to
-- the very policies it is supposed to operate behind.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_owner') then
    create role app_owner nologin noinherit nobypassrls;
  end if;
end $$;

grant usage on schema public, auth to app_owner;

do $$
declare r record;
begin
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I owner to app_owner', r.relname);
  end loop;

  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('alter function %s owner to app_owner', r.sig);
  end loop;
end $$;

-- auth.users stays owned by the superuser (as on Supabase), but its trigger
-- function is now owned by app_owner, so handle_new_user runs unprivileged.
grant insert, select on public.profiles to app_owner;

-- ── A brand new signup must still get a profile row ────────────────────────
insert into auth.users (id, email, raw_user_meta_data)
values ('44444444-4444-4444-8444-444444444444', 'dave@test.local', '{"locale":"en"}');

do $$
declare n int;
begin
  select count(*) into n from public.profiles where id = '44444444-4444-4444-8444-444444444444';
  if n <> 1 then
    raise exception 'FAIL: handle_new_user could not insert a profile under a non-superuser owner (got % rows)', n;
  end if;
end $$;
\echo 'PASS  owner-not-superuser: signup trigger still creates the profile'

-- ── The gamification RPCs must still work for a normal caller ──────────────
set role authenticated;
set request.jwt.claims = '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}';

do $$
declare n int; r jsonb;
begin
  perform public.ensure_daily_quests(
    current_date, '[{"quest_type":"review","goal":1}]'::jsonb);

  select count(*) into n from public.daily_quests where date = current_date;
  if n <> 1 then raise exception 'FAIL: ensure_daily_quests wrote nothing under a non-superuser owner (% rows)', n; end if;

  r := public.advance_quest(current_date, 'review', 1);
  if (r ->> 'completed')::boolean is not true then
    raise exception 'FAIL: advance_quest could not update under a non-superuser owner: %', r;
  end if;
  if (r -> 'awarded' ->> 'xp')::int <> 50 then
    raise exception 'FAIL: award_xp could not update profiles under a non-superuser owner: %', r;
  end if;

  r := public.touch_streak(current_date);
  if (r ->> 'streak')::int <> 1 then raise exception 'FAIL: touch_streak under non-superuser owner: %', r; end if;
end $$;
\echo 'PASS  owner-not-superuser: ensure_daily_quests / advance_quest / award_xp / touch_streak all work'

-- ── Joining someone else's room: the guest is not yet a member ─────────────
reset role;
reset request.jwt.claims;
set role authenticated;
set request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
insert into public.duo_rooms (room_code, host_id)
values ('ZZZ999', '11111111-1111-4111-8111-111111111111');

set request.jwt.claims = '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}';
do $$
declare v_room public.duo_rooms;
begin
  v_room := public.join_duo_room('ZZZ999');
  if v_room.guest_id <> '44444444-4444-4444-8444-444444444444' then
    raise exception 'FAIL: join_duo_room could not admit a guest under a non-superuser owner';
  end if;
end $$;
\echo 'PASS  owner-not-superuser: join_duo_room still admits a non-member guest'

-- ── And isolation is STILL enforced for ordinary callers ───────────────────
do $$
declare n int;
begin
  select count(*) into n from public.reviews;
  if n <> 0 then raise exception 'LEAK: dave sees % reviews belonging to others', n; end if;

  begin
    insert into public.swipes (user_id, media_id, media_type, direction)
    values ('11111111-1111-4111-8111-111111111111', 1, 'movie', 'like');
    raise exception 'LEAK: cross-user insert allowed after ownership change';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'PASS  owner-not-superuser: cross-user isolation still enforced'

reset role;
reset request.jwt.claims;
