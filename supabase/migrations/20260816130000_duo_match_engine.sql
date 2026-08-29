-- ===========================================================================
-- Duo match engine: authoritative, race-free mutual-like detection.
--
-- ── Why the client-side detector was not enough ────────────────────────────
-- Until now a match was decided entirely in the client: each side kept the
-- partner's likes in memory and intersected them with its own (see
-- `useDuoRoom`, "detection site 1/2"). That rule is CORRECT, and it is kept —
-- it is what makes the overlay instant and what lets Duo work with no backend
-- at all. What it is not is DURABLE. The votes it reasons over travel as
-- Realtime broadcast messages sent with `ack: false`, so:
--
--   * a dropped packet loses a match permanently — nothing ever re-checks;
--   * a socket reconnect (backgrounding a phone is enough) silently loses
--     every vote sent during the gap, in both directions;
--   * the two devices can therefore finish a session disagreeing about what
--     they matched on, with no arbiter to reconcile them.
--
-- ── Why not a trigger on `swipes` ──────────────────────────────────────────
-- Considered and rejected on two independent grounds. First, Duo votes never
-- reach `swipes` — they are ephemeral by design. Second, they MUST NOT: that
-- table feeds the personal taste vector and the daily swipe quota, so routing
-- duo votes through it would silently teach the recommender from titles the
-- user was only rating on someone else's behalf, and burn their quota doing
-- it. A trigger there would be solving this problem in the wrong table.
--
-- ── Why an RPC ─────────────────────────────────────────────────────────────
-- Recording the vote and deciding the match have to be ONE atomic step, and
-- only the database can do that. See `record_duo_vote` below for the lock that
-- makes it race-free.
-- ===========================================================================

-- ── The vote ledger ────────────────────────────────────────────────────────
-- Deliberately NOT added to the `supabase_realtime` publication. The votes are
-- read by `record_duo_vote` (server-side) and by nothing else; replicating ~60
-- rows per session to clients that never read them would be pure waste. Only
-- `duo_matches` — at most one row per agreed title — is published.
create table if not exists public.duo_votes (
  room_id    uuid              not null references public.duo_rooms(id) on delete cascade,
  voter_id   uuid              not null references public.profiles(id)  on delete cascade,
  media_id   bigint            not null,
  media_type public.media_kind not null,
  liked      boolean           not null,
  voted_at   timestamptz       not null default now(),
  -- Composite PK, not a surrogate id: it makes re-voting the same card an
  -- idempotent upsert rather than a duplicate row, which is what allows a
  -- client to safely retry a vote it is unsure landed.
  primary key (room_id, voter_id, media_id, media_type)
);

-- Partner lookup in `record_duo_vote` is (room_id, voter_id, media_id,
-- media_type) — a prefix of the PK — so the PK index already serves it and no
-- second index is warranted.

alter table public.duo_votes enable row level security;

-- Room members only, and only their own votes. A client never needs to SELECT
-- these (the RPC does the reasoning), but the policy is written so that the
-- table is not a hole if a future read path appears.
-- Drop-guarded, like every other policy in this project. Without this a push
-- that half-applied — or is simply run twice — dies on "policy already
-- exists", and a migration that cannot be re-run is a migration you cannot
-- recover with.
drop policy if exists "duo votes: own insert" on public.duo_votes;
create policy "duo votes: own insert" on public.duo_votes
  for insert to authenticated
  with check (
    voter_id = (select auth.uid())
    and exists (
      select 1 from public.duo_rooms r
      where r.id = duo_votes.room_id
        and ((select auth.uid()) = r.host_id or (select auth.uid()) = r.guest_id)
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
  using (
    exists (
      select 1 from public.duo_rooms r
      where r.id = duo_votes.room_id
        and ((select auth.uid()) = r.host_id or (select auth.uid()) = r.guest_id)
    )
  );

-- ── The atomic detector ────────────────────────────────────────────────────
create or replace function public.record_duo_vote(
  p_room_id    uuid,
  p_media_id   bigint,
  p_media_type public.media_kind,
  p_liked      boolean
)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_user    uuid := auth.uid();
  v_room    public.duo_rooms;
  v_partner uuid;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  /*
    THE LOCK IS THE WHOLE POINT OF THIS FUNCTION.

    Without it this is a textbook write-skew. Two people can like the same card
    within milliseconds of each other; under READ COMMITTED each transaction
    would insert its own vote, then look for the partner's vote and NOT SEE IT
    (the other transaction has not committed yet), and both would conclude
    "no match". The one case the feature exists for — simultaneous agreement —
    is exactly the case that would fail.

    Locking the room row first serialises every vote within a single room, so
    the second voter is guaranteed to observe the first one's committed vote.
    Contention is two users, so this costs nothing; rooms do not contend with
    each other at all.

    It doubles as the membership check: SECURITY DEFINER bypasses RLS, so this
    predicate is what stops a caller voting into a room they are not in.
  */
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

  -- A dislike is still recorded (it is how "how far has my partner got" is
  -- answered) but it can never create a match.
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

  -- ON CONFLICT DO NOTHING, not an error: the client-side detector may have
  -- already written this exact row from the other device. The unique key
  -- (room_id, media_id, media_type) absorbs the race instead of guarding it.
  insert into public.duo_matches (room_id, media_id, media_type)
  values (p_room_id, p_media_id, p_media_type)
  on conflict (room_id, media_id, media_type) do nothing;

  return true;
end;
$function$;

revoke execute on function public.record_duo_vote(uuid, bigint, public.media_kind, boolean)
  from public, anon;
grant execute on function public.record_duo_vote(uuid, bigint, public.media_kind, boolean)
  to authenticated;
