/**
 * Durable half of Duo: the room row and the match rows.
 *
 * The live vote traffic goes over an ephemeral broadcast channel (see
 * duoTransport.realtime.ts). This module persists only the two things worth
 * keeping — that a room existed, and what the two people agreed on — so the
 * result outlives the session and shows up on both accounts.
 *
 * EVERY function here is best-effort. Duo has to keep working with no backend,
 * no signed-in user, or no network, so a failure is swallowed and reported as
 * `null`/`false` rather than thrown: losing the durable copy of a match is a
 * shame, but taking down a working session over it would be much worse.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { cloudReady, currentUserId } from '@/lib/cloudSync';
import type { DuoCard } from '@/lib/duoTransport';

/** Creates the host's room row. Returns its id, or null if not persisted. */
export async function createRoomRow(code: string): Promise<string | null> {
  const userId = currentUserId();
  if (!cloudReady() || !userId) return null;

  try {
    const { data, error } = await supabase
      .from('duo_rooms')
      .insert({ room_code: code, host_id: userId })
      .select('id')
      .single();
    if (error) return null;
    return data?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Claims the guest seat.
 *
 * Goes through the join_duo_room RPC rather than an UPDATE, because RLS
 * deliberately hides a room from anyone who is not already in it — a guest
 * cannot see the row it is about to join, and that is what stops room codes
 * being enumerable.
 */
export async function joinRoomRow(code: string): Promise<string | null> {
  if (!cloudReady()) return null;

  try {
    const { data, error } = await supabase.rpc('join_duo_room', { p_room_code: code });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return (row as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Records a match.
 *
 * Both clients detect the same match independently and both call this, so the
 * write is an upsert against the (room_id, media_id, media_type) unique key —
 * the race is expected and absorbed rather than guarded against.
 */
export async function recordMatchRow(roomId: string | null, card: DuoCard): Promise<boolean> {
  if (!cloudReady() || !roomId) return false;

  try {
    const { error } = await supabase
      .from('duo_matches')
      .upsert(
        { room_id: roomId, media_id: card.tmdb_id, media_type: card.media_type },
        { onConflict: 'room_id,media_id,media_type', ignoreDuplicates: true },
      );
    return !error;
  } catch {
    return false;
  }
}

/** Marks a room finished. Nothing depends on it succeeding. */
export async function finishRoomRow(roomId: string | null): Promise<void> {
  if (!cloudReady() || !roomId) return;
  try {
    await supabase.from('duo_rooms').update({ status: 'finished' }).eq('id', roomId);
  } catch {
    // Ignored: a stale 'active' room is harmless.
  }
}

/**
 * Records one vote and asks the server whether it completed a match.
 *
 * This is the AUTHORITATIVE half of match detection. The client-side detector
 * in `useDuoRoom` is faster and works with no backend at all, but it reasons
 * over broadcast messages sent with `ack: false` — so a dropped packet, or a
 * socket reconnect while a phone was backgrounded, loses a match with nothing
 * to notice it afterwards. `record_duo_vote` writes the vote to a durable
 * ledger and decides the match under a room-level lock, so the answer does not
 * depend on any packet arriving.
 *
 * Returns true only when THIS vote is the one that completed the match.
 * Best-effort like everything else here: a false return may mean "no match" or
 * "could not reach the server", and the caller must treat those the same way,
 * because the local detector is still running underneath.
 */
export async function recordVoteRow(
  roomId: string | null,
  card: DuoCard,
  liked: boolean,
): Promise<boolean> {
  if (!cloudReady() || !roomId) return false;

  try {
    const { data, error } = await supabase.rpc('record_duo_vote', {
      p_room_id: roomId,
      p_media_id: card.tmdb_id,
      p_media_type: card.media_type,
      p_liked: liked,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/**
 * Subscribes to matches for one room and calls back on each new one.
 *
 * Postgres changes, NOT broadcast. `duo_matches` is in the `supabase_realtime`
 * publication and its RLS policy already limits reads to the room's two
 * members, so an INSERT is delivered to both devices and to nobody else — the
 * subscription needs no filtering of its own beyond the room id.
 *
 * This is the reconciliation layer. The vote broadcast is what makes a match
 * feel INSTANT; this is what makes it CERTAIN, because it is driven by
 * committed database state rather than by a packet that may never have landed.
 *
 * Returns an unsubscribe function; safe to call when there is no backend, in
 * which case it subscribes to nothing and the unsubscribe is a no-op.
 */
export function watchRoomMatches(
  roomId: string,
  onMatch: (row: { media_id: number; media_type: 'movie' | 'tv' }) => void,
): () => void {
  if (!cloudReady()) return () => {};

  let channel: RealtimeChannel;
  try {
    channel = supabase
      .channel(`duo-matches:${roomId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'duo_matches',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          const row = payload.new as { media_id?: number | string; media_type?: string } | null;
          if (!row || row.media_id == null) return;
          if (row.media_type !== 'movie' && row.media_type !== 'tv') return;
          // media_id is a bigint column, so it can arrive as a string.
          const mediaId = Number(row.media_id);
          if (!Number.isFinite(mediaId)) return;
          onMatch({ media_id: mediaId, media_type: row.media_type });
        },
      )
      .subscribe();
  } catch {
    return () => {};
  }

  return () => {
    void supabase.removeChannel(channel);
  };
}
