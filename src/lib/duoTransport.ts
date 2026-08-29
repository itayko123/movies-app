/**
 * Duo room transport.
 *
 * ── Why this is an interface ───────────────────────────────────────────────
 * Duo needs two phones to agree on a deck and exchange votes in real time. The
 * production carrier for that is Supabase Realtime, but wiring the UI directly
 * to it makes the whole feature untestable and unbuildable until the backend is
 * deployed and a real JWT exists — which is exactly why Duo shipped empty.
 *
 * (This comment used to say the `duo_sessions` table "already exists". It never
 * did: that was the abandoned v1 design, and the live schema is `duo_rooms` +
 * `duo_matches` keyed by a six-character room code. Corrected in Phase 6.)
 *
 * So the room logic talks to THIS interface, and the carrier is swappable.
 * There are three, picked by `openRoom` in order of reach:
 *
 *   realtime  — Supabase Realtime broadcast. The only one that crosses
 *               DEVICES. Requires a configured backend and a signed-in user.
 *               See duoTransport.realtime.ts.
 *   broadcast — `BroadcastChannel`: two tabs of the same browser, same origin.
 *               Not a stub that pretends — real messages, real ordering, real
 *               races — which is what makes the flow demonstrable without a
 *               backend.
 *   local     — an in-process bus, for React Native without a backend.
 *
 * The lower two cannot reach another device; that is a property of the carrier,
 * not of the room logic, which is identical in all three cases.
 */

import { cloudReady } from '@/lib/cloudSync';
import { openRealtimeRoom } from '@/lib/duoTransport.realtime';

/** A participant. `id` is per-tab/per-device, generated on join. */
export interface DuoMember {
  id: string;
  /** Display name; the host is whoever created the room. */
  name: string;
  isHost: boolean;
}

/** One card in the shared deck. Kept minimal — it crosses the wire. */
export interface DuoCard {
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  title: string;
  poster_path: string | null;
  release_year: number | null;
  vote_average: number | null;
}

export type DuoEvent =
  /** Announce presence. Answered by `welcome` from anyone already in. */
  | { type: 'hello'; member: DuoMember }
  | { type: 'welcome'; member: DuoMember }
  /**
   * The host's deck, broadcast verbatim.
   *
   * The deck is SENT rather than independently fetched by both sides. Two
   * clients calling the same TMDB query is not a guarantee of the same list —
   * popularity ordering shifts between requests, and each client filters
   * against its own swipe history — so "card 7" would mean different films on
   * the two phones and every match would be wrong.
   */
  | { type: 'deck'; items: DuoCard[] }
  /** A vote on one card. `liked: false` is still sent — see useDuoRoom. */
  | { type: 'vote'; from: string; key: string; liked: boolean }
  | { type: 'leave'; from: string };

export interface DuoTransport {
  readonly code: string;
  send(event: DuoEvent): void;
  close(): void;
}

/** Room codes people have to read aloud: no O/0/I/1 ambiguity. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** Normalises user-typed codes: trims, upper-cases, drops separators. */
export function normaliseRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(input: string): boolean {
  const code = normaliseRoomCode(input);
  return (
    code.length === ROOM_CODE_LENGTH &&
    [...code].every((char) => CODE_ALPHABET.includes(char))
  );
}

// ── In-process fallback bus (React Native, and web without BroadcastChannel) ─

type Listener = (event: DuoEvent) => void;
const buses = new Map<string, Set<Listener>>();

function openLocalBus(code: string, onEvent: Listener): DuoTransport {
  const listeners = buses.get(code) ?? new Set<Listener>();
  buses.set(code, listeners);
  listeners.add(onEvent);

  return {
    code,
    send(event) {
      // Never echo to the sender — matches BroadcastChannel semantics, so the
      // room logic behaves identically on both carriers.
      for (const listener of listeners) {
        if (listener !== onEvent) listener(event);
      }
    },
    close() {
      listeners.delete(onEvent);
      if (listeners.size === 0) buses.delete(code);
    },
  };
}

/** Which carrier a room is actually running on — surfaced in the Duo UI. */
export type DuoCarrier = 'realtime' | 'broadcast' | 'local';

export function duoCarrier(): DuoCarrier {
  if (cloudReady()) return 'realtime';
  return typeof BroadcastChannel === 'undefined' ? 'local' : 'broadcast';
}

/**
 * Opens a room channel on the best carrier available.
 *
 * Supabase Realtime when there is a backend and a signed-in user — the only
 * option that reaches a second DEVICE. Otherwise BroadcastChannel, which syncs
 * two tabs of the same browser, and finally an in-process bus.
 *
 * Returns immediately; there is no handshake to await, because presence is
 * established by the `hello`/`welcome` exchange in useDuoRoom, which is
 * transport-agnostic on purpose. Realtime buffers anything sent before its
 * socket is ready (see duoTransport.realtime.ts).
 */
export function openRoom(code: string, onEvent: (event: DuoEvent) => void): DuoTransport {
  if (cloudReady()) {
    try {
      return openRealtimeRoom(code, onEvent);
    } catch (err) {
      // Falling back beats failing to open a room at all — on the same device
      // the local carriers still work.
      if (__DEV__) console.warn('[duo] realtime unavailable, falling back', err);
    }
  }

  if (typeof BroadcastChannel === 'undefined') return openLocalBus(code, onEvent);

  const channel = new BroadcastChannel(`cineswipe-duo-${code}`);
  const handler = (message: MessageEvent) => onEvent(message.data as DuoEvent);
  channel.addEventListener('message', handler);

  return {
    code,
    send(event) {
      channel.postMessage(event);
    },
    close() {
      channel.removeEventListener('message', handler);
      channel.close();
    },
  };
}

/** Stable identity for a title across both clients. */
export function cardKey(card: { media_type: string; tmdb_id: number }): string {
  return `${card.media_type}:${card.tmdb_id}`;
}
