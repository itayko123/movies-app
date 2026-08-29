import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cardKey,
  generateRoomCode,
  normaliseRoomCode,
  openRoom,
  type DuoCard,
  type DuoEvent,
  type DuoMember,
  type DuoTransport,
} from '@/lib/duoTransport';
import {
  createRoomRow,
  finishRoomRow,
  joinRoomRow,
  recordMatchRow,
  recordVoteRow,
  watchRoomMatches,
} from '@/lib/duoCloud';
import { fetchDiscover, regionCountry, type MediaDraft } from '@/lib/tmdb';
import { hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useAppStore, selectTopGenres } from '@/state/store';

export type DuoRoomPhase =
  /** Nothing started. */
  | 'idle'
  /** Host created a room, waiting for someone to enter the code. */
  | 'hosting'
  /** Guest sent hello, waiting for the host's welcome + deck. */
  | 'joining'
  /** Both present, deck loaded, voting. */
  | 'swiping'
  /** Deck exhausted. */
  | 'finished'
  /** Partner disconnected, or the join failed. */
  | 'ended';

export interface DuoRoomState {
  phase: DuoRoomPhase;
  code: string | null;
  me: DuoMember | null;
  partner: DuoMember | null;
  deck: DuoCard[];
  index: number;
  current: DuoCard | null;
  /** Titles BOTH sides liked, newest first. */
  matches: DuoCard[];
  /** Set while the Match overlay is on screen; null once dismissed. */
  celebrating: DuoCard | null;
  /** How many cards the partner has voted on — drives the "they're ahead" hint. */
  partnerProgress: number;
  isLoadingDeck: boolean;
  error: string | null;

  host: () => void;
  join: (code: string) => void;
  vote: (liked: boolean) => void;
  dismissCelebration: () => void;
  leave: () => void;
}

/** How many cards a Duo session runs for. Long enough to find agreement. */
const DECK_SIZE = 30;

function toCard(draft: MediaDraft): DuoCard {
  return {
    tmdb_id: draft.tmdb_id,
    media_type: draft.media_type,
    title: draft.title,
    poster_path: draft.poster_path,
    release_year: draft.release_year,
    vote_average: draft.vote_average,
  };
}

let memberCounter = 0;
function newMember(isHost: boolean, name: string): DuoMember {
  memberCounter += 1;
  return { id: `${Date.now().toString(36)}-${memberCounter}`, name, isHost };
}

/**
 * Duo-Match: two people, one deck, votes exchanged live.
 *
 * ── How a match is decided ─────────────────────────────────────────────────
 * Two layers, and they are not redundant — they fail differently.
 *
 * FAST (local). Each client holds its own votes and the partner's likes, and a
 * match is simply the intersection. Both sides receive the same broadcast
 * events and apply the same rule, so they reach the SAME conclusion
 * independently — whoever votes second detects it on sending, the other on
 * receiving. That is why the check appears twice below; it is one rule
 * evaluated from both ends, not duplicated logic. It is instant, and it is the
 * ONLY layer when there is no backend, which is why it stays.
 *
 * CERTAIN (server). The fast layer reasons over broadcast messages sent with
 * `ack: false`, so it is lossy: a dropped packet, or a socket reconnect while a
 * phone was backgrounded, loses a match permanently and silently, and the two
 * devices finish the session disagreeing with nothing to reconcile them. So
 * every vote ALSO goes to `record_duo_vote`, which banks it durably and decides
 * the match atomically under a room lock, and both clients subscribe to INSERTs
 * on `duo_matches`. A match arrives by whichever route is quicker and survives
 * the loss of either one.
 *
 * `registerMatch` is idempotent across every path — see the key guard there.
 *
 * Dislikes are transmitted too, even though they can never create a match, so
 * each side can show how far the partner has got. Sending only likes would
 * make a partner who dislikes everything look disconnected.
 */
export function useDuoRoom(): DuoRoomState {
  const locale = useAppStore((s) => s.locale);
  const region = useAppStore((s) => s.region);
  const genreWeights = useAppStore((s) => s.genreWeights);
  const preferences = useAppStore((s) => s.preferences);
  const addDuoMatches = useAppStore((s) => s.addDuoMatches);

  const [phase, setPhase] = useState<DuoRoomPhase>('idle');
  const [code, setCode] = useState<string | null>(null);
  const [me, setMe] = useState<DuoMember | null>(null);
  const [partner, setPartner] = useState<DuoMember | null>(null);
  const [deck, setDeck] = useState<DuoCard[]>([]);
  const [index, setIndex] = useState(0);
  const [matches, setMatches] = useState<DuoCard[]>([]);
  /*
    A QUEUE, not a single card. Two matches can land within a few hundred
    milliseconds of each other — most easily when a reconnect delivers a
    backlog — and a plain `setCelebrating` would have the second overwrite the
    first, so one of the two agreements the pair just reached would never be
    shown at all. They are displayed one after the other instead.
  */
  const [celebrationQueue, setCelebrationQueue] = useState<DuoCard[]>([]);
  const [partnerProgress, setPartnerProgress] = useState(0);
  const [isLoadingDeck, setLoadingDeck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transport = useRef<DuoTransport | null>(null);
  /** My vote per card key. */
  const myVotes = useRef(new Map<string, boolean>());
  /** Card keys the partner liked. */
  const partnerLikes = useRef(new Set<string>());
  /** Deck kept in a ref so event handlers never close over a stale copy. */
  const deckRef = useRef<DuoCard[]>([]);
  const meRef = useRef<DuoMember | null>(null);
  /** Set when a partner arrives before the host's deck has finished loading. */
  const deckOwed = useRef(false);
  /**
   * Row id of the persisted room, or null when running without a backend.
   * Duo is fully functional either way — this only decides whether matches
   * also get written to `duo_matches`.
   */
  const roomRowId = useRef<string | null>(null);
  /**
   * The same id as state. The ref is what callbacks read synchronously; this is
   * what the match subscription depends on, since assigning to a ref does not
   * re-run an effect.
   */
  const [roomId, setRoomId] = useState<string | null>(null);
  /** Every card already registered as a match — the cross-path dedupe. */
  const matchedKeys = useRef(new Set<string>());

  const topGenres = useMemo(() => selectTopGenres(genreWeights, 3), [genreWeights]);
  const deckGenres = topGenres.length > 0 ? topGenres : (preferences?.genres ?? []);

  const teardown = useCallback(() => {
    transport.current?.close();
    transport.current = null;
    myVotes.current.clear();
    partnerLikes.current.clear();
    deckRef.current = [];
    deckOwed.current = false;
    roomRowId.current = null;
    matchedKeys.current.clear();
    setRoomId(null);
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Keeps the ref and the state copy of the room id in step. */
  const adoptRoomRow = useCallback((id: string | null) => {
    roomRowId.current = id;
    setRoomId(id);
  }, []);

  /** Records a match once, whichever of the detection paths found it. */
  const registerMatch = useCallback(
    (card: DuoCard, options?: { persist?: boolean }) => {
      const key = cardKey(card);
      // The same match legitimately arrives up to four ways: local detection on
      // send, local detection on receive, the vote RPC's return value, and the
      // duo_matches feed. First one wins, the rest are dropped — without this
      // the pair would celebrate the same title more than once.
      if (matchedKeys.current.has(key)) return;
      matchedKeys.current.add(key);

      setMatches((current) => [card, ...current]);
      setCelebrationQueue((queue) => [...queue, card]);
      hapticSuccess();
      // Durable copy on the server, when there is one. Fire-and-forget: the
      // overlay is already on screen and must not wait for a round trip.
      // Skipped when the match CAME from the server — it is already stored
      // there, and writing it back would be a pointless round trip.
      if (options?.persist !== false) void recordMatchRow(roomRowId.current, card);
      // Persist so the result outlives the session (see store.duoMatches).
      addDuoMatches([
        {
          media_item_id: cardKey(card),
          tmdb_id: card.tmdb_id,
          media_type: card.media_type,
          title: card.title,
          poster_path: card.poster_path,
          score: 1,
          at: Date.now(),
        },
      ]);
    },
    [addDuoMatches],
  );

  const publishDeck = useCallback((items: DuoCard[]) => {
    transport.current?.send({ type: 'deck', items });
  }, []);

  const loadDeck = useCallback(async () => {
    setLoadingDeck(true);
    setError(null);
    try {
      const originCountry = regionCountry(region) ?? undefined;
      const [movies, shows] = await Promise.all([
        fetchDiscover('movie', {
          page: 1,
          locale,
          ...(deckGenres.length > 0 ? { genres: deckGenres } : {}),
          ...(originCountry ? { originCountry } : {}),
          minVotes: originCountry ? 10 : 300,
          sortBy: originCountry ? 'vote_count.desc' : 'popularity.desc',
        }).catch(() => [] as MediaDraft[]),
        fetchDiscover('tv', {
          page: 1,
          locale,
          ...(deckGenres.length > 0 ? { genres: deckGenres } : {}),
          ...(originCountry ? { originCountry } : {}),
          minVotes: originCountry ? 10 : 300,
          sortBy: originCountry ? 'vote_count.desc' : 'popularity.desc',
        }).catch(() => [] as MediaDraft[]),
      ]);

      // Interleave so a session is not thirty films then thirty shows.
      const merged: DuoCard[] = [];
      for (let i = 0; i < Math.max(movies.length, shows.length); i++) {
        if (movies[i]) merged.push(toCard(movies[i]!));
        if (shows[i]) merged.push(toCard(shows[i]!));
      }
      const items = merged.slice(0, DECK_SIZE);
      if (items.length === 0) {
        setError('deck_empty');
        return;
      }

      deckRef.current = items;
      setDeck(items);
      setIndex(0);
      // A partner who arrived while this was in flight is still waiting.
      if (deckOwed.current) {
        deckOwed.current = false;
        publishDeck(items);
        setPhase('swiping');
      }
    } finally {
      setLoadingDeck(false);
    }
  }, [locale, region, deckGenres, publishDeck]);

  const handleEvent = useCallback(
    (event: DuoEvent) => {
      const self = meRef.current;
      if (!self) return;

      switch (event.type) {
        case 'hello': {
          // Someone entered our code. Only the host answers and owns the deck.
          setPartner(event.member);
          transport.current?.send({ type: 'welcome', member: self });
          if (!self.isHost) return;
          hapticSuccess();
          if (deckRef.current.length > 0) {
            publishDeck(deckRef.current);
            setPhase('swiping');
          } else {
            deckOwed.current = true;
          }
          return;
        }

        case 'welcome': {
          setPartner(event.member);
          hapticSuccess();
          return;
        }

        case 'deck': {
          deckRef.current = event.items;
          setDeck(event.items);
          setIndex(0);
          setPhase('swiping');
          return;
        }

        case 'vote': {
          if (event.from === self.id) return;
          setPartnerProgress((n) => n + 1);
          if (!event.liked) return;

          partnerLikes.current.add(event.key);
          // Detection site 1: they liked something I had already liked.
          if (myVotes.current.get(event.key) === true) {
            const card = deckRef.current.find((c) => cardKey(c) === event.key);
            if (card) registerMatch(card);
          }
          return;
        }

        case 'leave': {
          if (event.from === self.id) return;
          setPartner(null);
          setPhase('ended');
          return;
        }
      }
    },
    [publishDeck, registerMatch],
  );

  const connect = useCallback(
    (roomCode: string, member: DuoMember) => {
      teardown();
      meRef.current = member;
      setMe(member);
      setCode(roomCode);
      setMatches([]);
      setPartner(null);
      setPartnerProgress(0);
      setCelebrationQueue([]);
      setDeck([]);
      setIndex(0);
      transport.current = openRoom(roomCode, handleEvent);
    },
    [handleEvent, teardown],
  );

  const host = useCallback(() => {
    const roomCode = generateRoomCode();
    connect(roomCode, newMember(true, 'Host'));
    setPhase('hosting');
    // Both run concurrently: the deck fetch is the slow one, and the room row
    // is optional, so neither should gate the other.
    void createRoomRow(roomCode).then(adoptRoomRow);
    void loadDeck();
  }, [adoptRoomRow, connect, loadDeck]);

  const join = useCallback(
    (input: string) => {
      const roomCode = normaliseRoomCode(input);
      const member = newMember(false, 'Guest');
      connect(roomCode, member);
      setPhase('joining');
      // Announce ourselves; the host replies with `welcome` + `deck`.
      transport.current?.send({ type: 'hello', member });
      void joinRoomRow(roomCode).then(adoptRoomRow);
    },
    [adoptRoomRow, connect],
  );

  const vote = useCallback(
    (liked: boolean) => {
      const self = meRef.current;
      const card = deckRef.current[index];
      if (!self || !card) return;

      const key = cardKey(card);
      myVotes.current.set(key, liked);
      transport.current?.send({ type: 'vote', from: self.id, key, liked });
      hapticMedium();

      // Detection site 2: I liked something they had already liked.
      if (liked && partnerLikes.current.has(key)) registerMatch(card);

      // Detection site 3, the authoritative one. Banks the vote durably and
      // returns true when the SERVER decides this vote completed the match,
      // which is how a match still surfaces when the partner's broadcast never
      // arrived. Fire-and-forget so it never delays the card advancing.
      void recordVoteRow(roomRowId.current, card, liked).then((matched) => {
        if (matched) registerMatch(card, { persist: false });
      });

      const next = index + 1;
      setIndex(next);
      if (next >= deckRef.current.length) {
        setPhase('finished');
        void finishRoomRow(roomRowId.current);
      }
    },
    [index, registerMatch],
  );

  /*
    Detection site 4: matches the server tells us about.

    Covers the one case no local path can — the partner liked a card, the server
    matched it, and the broadcast that would have told us was lost. RLS on
    `duo_matches` already limits delivery to the room's two members, so this
    needs no filtering of its own beyond the room id.
  */
  useEffect(() => {
    if (!roomId) return;
    return watchRoomMatches(roomId, ({ media_id, media_type }) => {
      const card = deckRef.current.find((c) => cardKey(c) === `${media_type}:${media_id}`);
      // A match for a title absent from our copy of the deck cannot be
      // rendered, and must not be invented.
      if (card) registerMatch(card, { persist: false });
    });
  }, [roomId, registerMatch]);

  /** Shows the next queued match, when the pair agreed on several in a row. */
  const dismissCelebration = useCallback(() => {
    setCelebrationQueue((queue) => queue.slice(1));
  }, []);

  const leave = useCallback(() => {
    const self = meRef.current;
    if (self) transport.current?.send({ type: 'leave', from: self.id });
    teardown();
    meRef.current = null;
    setPhase('idle');
    setCode(null);
    setMe(null);
    setPartner(null);
    setDeck([]);
    setIndex(0);
    setMatches([]);
    setCelebrationQueue([]);
    setPartnerProgress(0);
    setError(null);
  }, [teardown]);

  return {
    phase,
    code,
    me,
    partner,
    deck,
    index,
    current: deck[index] ?? null,
    matches,
    celebrating: celebrationQueue[0] ?? null,
    partnerProgress,
    isLoadingDeck,
    error,
    host,
    join,
    vote,
    dismissCelebration,
    leave,
  };
}
