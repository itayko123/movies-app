-- ===========================================================================
-- delete_own_account — the RPC the client has always called and that has
-- never existed.
--
-- `src/lib/cloudSync.ts:478` calls `supabase.rpc('delete_own_account')`. That
-- function is defined nowhere: not in the live database, and not in any repo
-- SQL. Every "Delete account" tap has therefore failed with PGRST202 and the
-- UI has been reporting a server error. Both app stores require a working
-- in-app deletion path for accounts created in-app, so this is a submission
-- blocker rather than a cosmetic bug.
-- ===========================================================================

create or replace function public.delete_own_account()
 returns void
 language plpgsql
 security definer
 -- Empty search_path, fully-qualified references. An unpinned search_path on
 -- a SECURITY DEFINER function that deletes auth rows is a privilege
 -- escalation waiting to happen.
 set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  /*
    ONE delete, and the graph does the rest.

      auth.users
        └── profiles            (id → auth.users, ON DELETE CASCADE)
              ├── swipes        ON DELETE CASCADE
              ├── watchlist     ON DELETE CASCADE
              ├── reviews       ON DELETE CASCADE
              ├── daily_quests  ON DELETE CASCADE
              ├── duo_rooms     host_id  → ON DELETE CASCADE
              │     └── duo_matches      ON DELETE CASCADE
              └── duo_rooms     guest_id → ON DELETE SET NULL

    Deleting row-by-row instead would be strictly worse: it could partially
    succeed, and it would need this list kept in sync with the schema by hand.

    The guest_id asymmetry is deliberate and correct. Rooms this user HOSTED
    are theirs and go with them, taking their matches. Rooms they merely
    JOINED belong to the other person — nulling the guest leaves the host's
    room and history intact rather than destroying someone else's data as a
    side effect of this user leaving.
  */
  delete from auth.users where id = v_user;
end;
$function$;

-- Callable by a signed-in user only, and only ever for themselves — the
-- function reads auth.uid() and ignores any argument, so there is no shape of
-- call that deletes somebody else.
revoke execute on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
