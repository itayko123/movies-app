/**
 * Supabase Realtime carrier for a Duo room.
 *
 * Implements the same `DuoTransport` interface as the BroadcastChannel mock, so
 * `useDuoRoom` is unchanged by which one is in use — the difference is only
 * that this one crosses devices.
 *
 * ── Broadcast, not Postgres changes ────────────────────────────────────────
 * Votes travel over THIS channel as ephemeral broadcast messages rather than as
 * replicated table rows. Sixty replication events per session, to carry
 * something the other client acts on once and never refers to again, would be a
 * poor trade against the latency this channel exists to avoid.
 *
 * That is a statement about REPLICATION, not about durability, and the
 * distinction matters: as of Phase 6 every vote is ALSO written to
 * `public.duo_votes` via the `record_duo_vote` RPC, because a broadcast sent
 * with `ack: false` is lossy and a lost vote silently costs a match. The rule
 * is that the fast path travels here and the durable path goes to the database
 * — `duo_votes` is deliberately NOT in the realtime publication, while
 * `duo_matches` is, so only the CONCLUSION is replicated, never the traffic
 * that produced it. See supabase_schema.sql.
 *
 * ── Why sends are buffered ─────────────────────────────────────────────────
 * A channel drops anything sent before it reaches SUBSCRIBED, and the room
 * logic sends `hello` the instant it opens — so on a real network the guest's
 * announcement would vanish and the room would hang at "waiting". Queueing
 * until the socket is ready is what makes joining reliable rather than
 * dependent on how fast the handshake happened to be.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { DuoEvent, DuoTransport } from '@/lib/duoTransport';

const EVENT = 'duo';

export function openRealtimeRoom(
  code: string,
  onEvent: (event: DuoEvent) => void,
): DuoTransport {
  let ready = false;
  let closed = false;
  const pending: DuoEvent[] = [];

  const channel: RealtimeChannel = supabase.channel(`duo:${code}`, {
    config: {
      broadcast: {
        // Never echo our own messages: the local bus and BroadcastChannel both
        // behave this way, and the room logic assumes it (a self-echoed vote
        // would be counted as the partner's and could fake a match).
        self: false,
        // Fire-and-forget. Waiting for an ack would put a network round trip
        // in front of the swipe animation.
        ack: false,
      },
    },
  });

  const flush = () => {
    while (pending.length > 0) {
      const event = pending.shift()!;
      void channel.send({ type: 'broadcast', event: EVENT, payload: event });
    }
  };

  channel
    .on('broadcast', { event: EVENT }, (message) => {
      if (closed) return;
      onEvent(message.payload as DuoEvent);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ready = true;
        flush();
      }
    });

  return {
    code,
    send(event) {
      if (closed) return;
      if (!ready) {
        pending.push(event);
        return;
      }
      void channel.send({ type: 'broadcast', event: EVENT, payload: event });
    },
    close() {
      closed = true;
      pending.length = 0;
      void supabase.removeChannel(channel);
    },
  };
}
