import { useCallback, useEffect, useRef, useState } from 'react';
import {
  I18nManager,
  ScrollView,
  Share,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';

import { AppText } from '@/components/AppText';
import { SectionHeader } from '@/components/SectionHeader';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { DuoIntro } from '@/components/DuoIntro';
import { MatchOverlay } from '@/components/MatchOverlay';
import { Skeleton } from '@/components/Skeleton';
import { useDuoRoom } from '@/hooks/useDuoRoom';
import { isValidRoomCode, normaliseRoomCode, type DuoCard } from '@/lib/duoTransport';
import { imageUrl } from '@/lib/tmdb';
import { useT } from '@/i18n';
import { useAppStore, type DuoMatch } from '@/state/store';
import { C, R, SECTION_ICON, SHADOW, SPACE } from '@/theme/tokens';

function inviteUrl(code: string): string {
  // https link opens the app via App Links/Universal Links and falls back to
  // the web; the cineswipe:// scheme is registered for the same route.
  return `https://cineswipe.app/duo/invite/${code}`;
}

/** Poster thumbnails use fixed pixel sizes — never percentages. */
const THUMB = { width: 56, height: 80 } as const;

/*
  Vote discs, deliberately identical in treatment to DeckActions.

  Duo used to fill the like button SOLID CYAN with a black heart, which was
  wrong twice: it broke the rule in tokens.ts that the app accent is never a
  swipe verdict (green/red mean yes/no and nothing else), and it made the two
  decks in the app look unrelated even though the gesture is the same. The
  reference treatment — and the main deck's — is a NEUTRAL translucent disc
  carrying a COLOURED GLYPH, so that is what Duo uses now.
*/
const DISC = 64;
const DISC_FILL = 'rgba(255,255,255,0.14)';
const DISC_GLYPH = 0.47;

/** Directional glyphs must mirror under RTL; evaluated per render, never hoisted. */
function rtlFlip() {
  return I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined;
}

/** A match kept from an earlier session. */
function SavedMatchRow({ match, onPress }: { match: DuoMatch; onPress: () => void }) {
  const poster = imageUrl(match.poster_path, 'w342');
  return (
    <PressableScale
      onPress={onPress}
      haptic="selection"
      activeScale={0.97}
      accessibilityRole="button"
    >
      <GlassView className="rounded-3xl flex-row items-center gap-4 p-3">
        <View
          style={{
            ...THUMB,
            borderRadius: R.media,
            overflow: 'hidden',
            backgroundColor: C.surface,
          }}
        >
          {poster && <Image source={{ uri: poster }} style={THUMB} contentFit="cover" />}
        </View>
        <View className="flex-1">
          <AppText variant="bodyStrong" numberOfLines={2}>
            {match.title}
          </AppText>
          <AppText variant="caption" className="mt-1 text-txt-tertiary">
            {new Date(match.at).toLocaleDateString()}
          </AppText>
        </View>
        <Ionicons
          name="chevron-forward"
          size={18}
          color={C.textTertiary}
          style={rtlFlip()}
        />
      </GlassView>
    </PressableScale>
  );
}

/** The live vote card during a session. */
function VoteCard({ card, width }: { card: DuoCard; width: number }) {
  const poster = imageUrl(card.poster_path, 'w500');
  const height = Math.round(width * 1.5);
  return (
    <View
      style={{
        width,
        height,
        borderRadius: R.hero,
        overflow: 'hidden',
        backgroundColor: C.surface,
        ...SHADOW.card,
      }}
    >
      {poster && (
        <Image
          source={{ uri: poster }}
          style={{ width, height }}
          contentFit="cover"
          transition={160}
          cachePolicy="memory-disk"
          recyclingKey={`${card.media_type}-${card.tmdb_id}`}
        />
      )}
      <View className="absolute bottom-0 start-0 end-0 p-4 bg-black/70">
        <AppText variant="bodyStrong" numberOfLines={2} style={{ color: C.text }}>
          {card.title}
        </AppText>
        <AppText variant="caption" style={{ color: 'rgba(255,255,255,0.75)' }}>
          {[card.release_year, card.vote_average ? `★ ${card.vote_average.toFixed(1)}` : null]
            .filter(Boolean)
            .join(' · ')}
        </AppText>
      </View>
    </View>
  );
}

export default function DuoScreen() {
  const t = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const room = useDuoRoom();
  const duoMatches = useAppStore((s) => s.duoMatches);
  const hasSeenDuoIntro = useAppStore((s) => s.hasSeenDuoIntro);
  const completeDuoIntro = useAppStore((s) => s.completeDuoIntro);

  const [joinCode, setJoinCode] = useState('');
  const [showJoin, setShowJoin] = useState(false);

  /*
    Auto-join from an invite deep link.

    `/duo/invite/<CODE>` redirects here with the code as a param rather than
    running its own duo session — this tab owns the only implementation that
    speaks to the live schema, and a second copy would drift.

    The param is CONSUMED once used, for the same reason the watchlist
    consumes its segment param: a tab screen stays mounted, so a stale
    ?joinCode= left in place would try to re-join every time the tab regained
    focus, long after the room had ended. `attempted` additionally guards
    against a double-join inside a single mount, since joining twice would
    have the guest fight itself for the slot.
  */
  const params = useLocalSearchParams<{ joinCode?: string }>();
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    const invited = params.joinCode;
    if (!invited) return;

    router.setParams({ joinCode: undefined });

    if (attempted.current === invited) return;
    attempted.current = invited;

    // A malformed code should surface the join sheet with the code prefilled
    // rather than firing a request that can only fail.
    if (!isValidRoomCode(invited)) {
      setJoinCode(invited);
      setShowJoin(true);
      return;
    }
    room.join(invited);
  }, [params.joinCode, room, router]);

  const openTitle = useCallback(
    (item: { tmdb_id: number; media_type: string; title: string; poster_path: string | null }) => {
      router.push({
        pathname: '/media/[id]',
        params: {
          id: String(item.tmdb_id),
          type: item.media_type,
          title: item.title,
          poster: item.poster_path ?? '',
        },
      });
    },
    [router],
  );

  const startHosting = useCallback(() => {
    completeDuoIntro();
    room.host();
  }, [completeDuoIntro, room]);

  const cardWidth = Math.min(width - 88, 300);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{
          padding: SPACE.edge,
          // Clears the floating tab bar.
          paddingBottom: 130,
          gap: SPACE.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1">
          <AppText variant="title">{t('duo.title')}</AppText>
          <AppText variant="caption">{t('duo.subtitle')}</AppText>
        </View>

        {/* ── Idle: intro, host, or join ─────────────────────────────────── */}
        {room.phase === 'idle' && (
          <View className="gap-4">
            {!hasSeenDuoIntro && duoMatches.length === 0 ? (
              <DuoIntro onStart={startHosting} />
            ) : (
              <PressableScale
                onPress={startHosting}
                haptic="success"
                accessibilityRole="button"
                style={{
                  backgroundColor: C.accent,
                  borderRadius: R.pill,
                  paddingVertical: SPACE.lg,
                  alignItems: 'center',
                  ...SHADOW.accent,
                }}
              >
                <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
                  {t('duo.createRoom')}
                </AppText>
              </PressableScale>
            )}

            {!showJoin ? (
              <PressableScale
                onPress={() => setShowJoin(true)}
                haptic="light"
                accessibilityRole="button"
                style={{ paddingVertical: SPACE.md, alignItems: 'center' }}
              >
                {/*
                  MEASURED at rgb(100,116,139) before this fix: `text-brand`
                  lost to the caption variant's own `text-txt-tertiary`,
                  because NativeWind resolves conflicting text-colour classes
                  by CSS emission order, not by the order they appear in the
                  string. The only reliable override is an inline style.
                */}
                <AppText variant="caption" style={{ color: C.accent }}>
                  {t('duo.haveCode')}
                </AppText>
              </PressableScale>
            ) : (
              <GlassView className="rounded-3xl p-4 gap-3">
                <AppText variant="bodyStrong">{t('duo.joinRoom')}</AppText>
                <TextInput
                  value={joinCode}
                  onChangeText={(text) => setJoinCode(normaliseRoomCode(text))}
                  placeholder={t('duo.codePlaceholder')}
                  placeholderTextColor={C.textTertiary}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={6}
                  accessibilityLabel={t('duo.joinRoom')}
                  style={{
                    backgroundColor: C.bg,
                    borderRadius: R.chip,
                    color: C.text,
                    paddingHorizontal: SPACE.lg,
                    paddingVertical: SPACE.lg,
                    fontSize: 22,
                    letterSpacing: 6,
                    textAlign: 'center',
                    // Codes are Latin even in Hebrew UI; without this the
                    // caret and letters lay out right-to-left under RTL.
                    writingDirection: 'ltr',
                  }}
                />
                <PressableScale
                  onPress={() => {
                    completeDuoIntro();
                    room.join(joinCode);
                  }}
                  disabled={!isValidRoomCode(joinCode)}
                  haptic="success"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !isValidRoomCode(joinCode) }}
                  style={{
                    // Violet is the DUO affordance colour per tokens.ts —
                    // deliberately not the app accent, which would erase the
                    // distinction from an ordinary primary CTA.
                    backgroundColor: isValidRoomCode(joinCode)
                      ? C.secondary
                      : C.surfaceRaised,
                    borderRadius: R.pill,
                    paddingVertical: SPACE.lg,
                    alignItems: 'center',
                  }}
                >
                  <AppText
                    variant="bodyStrong"
                    style={{
                      color: isValidRoomCode(joinCode) ? C.onLight : C.textTertiary,
                    }}
                  >
                    {t('duo.joinAction')}
                  </AppText>
                </PressableScale>
              </GlassView>
            )}
          </View>
        )}

        {/* ── Hosting: show the code and wait ────────────────────────────── */}
        {room.phase === 'hosting' && room.code && (
          <GlassView className="rounded-sheet p-6 items-center gap-4">
            <AppText variant="subtitle">{t('duo.waitingTitle')}</AppText>
            <AppText variant="caption" className="text-center">
              {t('duo.waitingBody')}
            </AppText>

            {/*
              THE ROOM CODE WAS INVISIBLE. Measured white-on-white at a
              contrast ratio of 1.00:1 — the `text-brand` class lost to the
              hero variant's own `text-txt` (white), and the card behind it
              was `#FFFFFF`. The single thing a host has to read aloud
              rendered as an empty white box.

              Note the intended design would have been bad too: accent cyan
              on white measures 2.37:1, under the 3:1 floor for large text.
              Moving the code onto a dark surface gives 7.48:1 and matches
              the rest of the app, so the code now sits on C.surface.
            */}
            <View
              style={{
                backgroundColor: C.surface,
                borderRadius: R.card,
                paddingHorizontal: SPACE.xxl,
                paddingVertical: SPACE.lg,
                alignItems: 'center',
                gap: SPACE.xs,
              }}
              accessibilityLabel={t('duo.codeLabel')}
            >
              <AppText variant="label" style={{ color: C.textTertiary }}>
                {t('duo.codeLabel')}
              </AppText>
              <AppText
                variant="hero"
                style={{
                  color: C.accent,
                  letterSpacing: 10,
                  textAlign: 'center',
                  // The code is Latin/numeric even in the Hebrew UI.
                  writingDirection: 'ltr',
                }}
              >
                {room.code}
              </AppText>
            </View>

            {/*
              The ONLY white surface left in Duo, and it is required: a QR
              code needs a light quiet zone to scan reliably. This is not a
              missed token.
            */}
            <View style={{ backgroundColor: '#FFFFFF', padding: SPACE.md, borderRadius: R.card }}>
              <QRCode value={inviteUrl(room.code)} size={132} backgroundColor="#FFFFFF" />
            </View>

            {room.isLoadingDeck && (
              <View className="flex-row items-center gap-2">
                <Skeleton className="h-3 w-3 rounded-full" />
                <AppText variant="caption">{t('duo.preparingDeck')}</AppText>
              </View>
            )}

            <View className="flex-row gap-3">
              <PressableScale
                onPress={() =>
                  void Share.share({
                    message: t('duo.shareMessage', { code: room.code ?? '' }),
                    url: inviteUrl(room.code ?? ''),
                  })
                }
                haptic="light"
                accessibilityRole="button"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: SPACE.sm,
                  backgroundColor: C.surface,
                  borderRadius: R.pill,
                  paddingHorizontal: SPACE.xl,
                  paddingVertical: SPACE.md,
                }}
              >
                <Ionicons name="share-outline" size={16} color={C.text} />
                <AppText variant="caption">{t('duo.share')}</AppText>
              </PressableScale>

              <PressableScale
                onPress={room.leave}
                haptic="light"
                accessibilityRole="button"
                style={{ paddingHorizontal: SPACE.xl, paddingVertical: SPACE.md }}
              >
                <AppText variant="caption">
                  {t('common.cancel')}
                </AppText>
              </PressableScale>
            </View>
          </GlassView>
        )}

        {room.phase === 'joining' && (
          <GlassView className="rounded-sheet p-8 items-center gap-3">
            <Ionicons name="link" size={32} color={C.secondary} />
            <AppText variant="subtitle">{t('duo.connecting')}</AppText>
            <AppText variant="caption" className="text-center">
              {t('duo.connectingBody', { code: room.code ?? '' })}
            </AppText>
            <PressableScale
              onPress={room.leave}
              haptic="light"
              accessibilityRole="button"
              style={{ paddingVertical: 10 }}
            >
              <AppText variant="caption" className="text-txt-tertiary">
                {t('common.cancel')}
              </AppText>
            </PressableScale>
          </GlassView>
        )}

        {/* ── Live session ───────────────────────────────────────────────── */}
        {room.phase === 'swiping' && room.current && (
          <View className="gap-4 items-center">
            <View className="flex-row items-center justify-between w-full">
              <View className="flex-row items-center gap-1.5">
                {/*
                  The dot was always cyan, so "connected" and "waiting" looked
                  identical and only the label distinguished them. Presence is
                  exactly what a colour cue is for: alive reads green, absent
                  reads dim.
                */}
                <Ionicons
                  name="ellipse"
                  size={9}
                  color={room.partner ? C.like : C.textTertiary}
                />
                <AppText variant="caption">
                  {room.partner ? t('duo.partnerConnected') : t('duo.partnerAway')}
                </AppText>
              </View>
              <AppText variant="caption">
                {t('duo.progress', { current: room.index + 1, total: room.deck.length })}
              </AppText>
            </View>

            <VoteCard card={room.current} width={cardWidth} />

            {room.matches.length > 0 && (
              <AppText variant="caption" style={{ color: C.accent }}>
                {t('duo.matchesSoFar', { count: room.matches.length })}
              </AppText>
            )}

            <View className="flex-row" style={{ gap: SPACE.xxl }}>
              <PressableScale
                onPress={() => room.vote(false)}
                haptic="light"
                // A small circular target needs a deeper squash than the app
                // default for the press to register visually — same value
                // DeckActions uses.
                activeScale={0.86}
                accessibilityRole="button"
                accessibilityLabel={t('deck.nope')}
                style={{
                  width: DISC,
                  height: DISC,
                  borderRadius: DISC / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: DISC_FILL,
                  boxShadow: '0px 6px 16px rgba(0,0,0,0.45)',
                  elevation: 6,
                }}
              >
                <Ionicons
                  name="close"
                  size={Math.round(DISC * DISC_GLYPH)}
                  color={C.nope}
                />
              </PressableScale>

              <PressableScale
                onPress={() => room.vote(true)}
                haptic="medium"
                activeScale={0.86}
                accessibilityRole="button"
                accessibilityLabel={t('deck.like')}
                style={{
                  width: DISC,
                  height: DISC,
                  borderRadius: DISC / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: DISC_FILL,
                  boxShadow: '0px 6px 16px rgba(0,0,0,0.45)',
                  elevation: 6,
                }}
              >
                <Ionicons
                  name="heart"
                  size={Math.round(DISC * DISC_GLYPH)}
                  color={C.like}
                />
              </PressableScale>
            </View>

            <PressableScale
              onPress={room.leave}
              haptic="light"
              accessibilityRole="button"
              style={{ paddingVertical: SPACE.sm }}
            >
              <AppText variant="caption">
                {t('duo.endSession')}
              </AppText>
            </PressableScale>
          </View>
        )}

        {(room.phase === 'finished' || room.phase === 'ended') && (
          <GlassView className="rounded-sheet p-6 items-center gap-3">
            <Ionicons
              name={room.phase === 'finished' ? 'checkmark-done-circle' : 'unlink'}
              size={36}
              color={room.phase === 'finished' ? C.accent : C.textTertiary}
            />
            <AppText variant="subtitle">
              {room.phase === 'finished' ? t('duo.sessionDone') : t('duo.partnerLeft')}
            </AppText>
            <AppText variant="caption" className="text-center">
              {t('duo.sessionSummary', { count: room.matches.length })}
            </AppText>
            <PressableScale
              onPress={room.leave}
              haptic="medium"
              accessibilityRole="button"
              style={{
                backgroundColor: C.accent,
                borderRadius: R.pill,
                paddingHorizontal: SPACE.xxl,
                paddingVertical: SPACE.md,
                marginTop: SPACE.xs,
                ...SHADOW.accent,
              }}
            >
              <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
                {t('duo.startAnother')}
              </AppText>
            </PressableScale>
          </GlassView>
        )}

        {/*
          A DEAD END, until now. This was a single line of caption text with no
          way out: `room.error` is set when the deck comes back empty, and the
          only recovery was to guess that leaving and re-hosting would help.
          It also rendered GREY rather than red — `text-nope` lost to the
          caption variant's own `text-txt-tertiary` on emission order, the same
          dead-class pattern as the room code and the "got a code?" link.

          Now it states the problem and offers the action that actually fixes
          it. `leave()` is the reset: it tears the room down and returns to
          idle, from which hosting fetches a fresh deck.
        */}
        {room.error && (
          <GlassView className="rounded-sheet items-center" style={{ padding: SPACE.card, gap: SPACE.md }}>
            <View
              className="items-center justify-center rounded-full"
              style={{
                width: SECTION_ICON.size,
                height: SECTION_ICON.size,
                borderRadius: SECTION_ICON.radius,
                backgroundColor: C.nopeSoft,
              }}
            >
              <Ionicons name="alert-circle-outline" size={22} color={C.nope} />
            </View>
            <AppText variant="bodyStrong" className="text-center">
              {t('common.error')}
            </AppText>
            <AppText variant="caption" className="text-center">
              {t('duo.errorBody')}
            </AppText>
            <PressableScale
              onPress={room.leave}
              haptic="light"
              accessibilityRole="button"
              style={{
                backgroundColor: C.surfaceRaised,
                borderRadius: R.pill,
                paddingHorizontal: SPACE.xxl,
                paddingVertical: SPACE.md,
                marginTop: SPACE.xs,
              }}
            >
              <AppText variant="bodyStrong" style={{ color: C.accent }}>
                {t('common.retry')}
              </AppText>
            </PressableScale>
          </GlassView>
        )}

        {/* ── Saved matches ──────────────────────────────────────────────── */}
        {duoMatches.length > 0 && room.phase !== 'swiping' && (
          <View className="gap-3">
            <SectionHeader icon="heart" title={t('duo.savedMatches')} />
            <AppText variant="caption">{t('duo.savedMatchesBody')}</AppText>
            {duoMatches.slice(0, 10).map((match) => (
              <SavedMatchRow
                key={match.media_item_id}
                match={match}
                onPress={() => openTitle(match)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      {/*
        The payoff. Rendered last so it sits above the scroll view.

        Keyed by the title so consecutive matches each get a FRESH overlay.
        `useCelebrationProgress` starts its ticker on mount, so without the key
        a second match arriving while the first was still on screen would swap
        the poster underneath a finished animation — the burst and shockwave
        would simply not play for it.
      */}
      {room.celebrating && (
        <MatchOverlay
          key={`${room.celebrating.media_type}:${room.celebrating.tmdb_id}`}
          card={room.celebrating}
          onDismiss={room.dismissCelebration}
        />
      )}
    </SafeAreaView>
  );
}
