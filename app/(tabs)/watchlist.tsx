import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { SaveSheet } from '@/components/SaveSheet';
import { imageUrl } from '@/lib/tmdb';
import { hapticWarning } from '@/lib/haptics';
import { useT, type TranslationKey } from '@/i18n';
import { useGenreLabel } from '@/i18n/genres';
import { C, R, SECTION_ICON, SHADOW, SPACE } from '@/theme/tokens';
import {
  useAppStore,
  selectWatchlist,
  selectLiked,
  selectSeen,
  type LibraryEntry,
} from '@/state/store';
import type { MediaItemRow } from '@/types/media';

type Segment = 'saved' | 'liked' | 'seen';
type SortKey = 'recent' | 'rating' | 'year' | 'title';
type ViewMode = 'grid' | 'list';

const SEGMENTS: Array<{ key: Segment; label: TranslationKey; icon: keyof typeof Ionicons.glyphMap }> = [
  { key: 'saved', label: 'watchlist.tabSaved', icon: 'bookmark' },
  { key: 'liked', label: 'watchlist.tabLiked', icon: 'heart' },
  { key: 'seen', label: 'watchlist.tabSeen', icon: 'eye' },
];

const SORTS: Array<{ key: SortKey; label: TranslationKey }> = [
  { key: 'recent', label: 'watchlist.sortRecent' },
  { key: 'rating', label: 'watchlist.sortRating' },
  { key: 'year', label: 'watchlist.sortYear' },
  { key: 'title', label: 'watchlist.sortTitle' },
];

const EMPTY_COPY: Record<Segment, { title: TranslationKey; body: TranslationKey }> = {
  saved: { title: 'watchlist.empty', body: 'watchlist.emptyBody' },
  liked: { title: 'watchlist.emptyLiked', body: 'watchlist.emptyLikedBody' },
  seen: { title: 'watchlist.emptySeen', body: 'watchlist.emptySeenBody' },
};

const GUTTER = 14;
const EDGE = 20;
/** List-row thumbnail. Fixed pixels — never percentage sizing. */
const ROW_THUMB = { width: 72, height: 108 } as const;

/**
 * One height for every segment pill, active or not.
 *
 * Fixed rather than left to padding so the selected capsule can never come out
 * a different size from its neighbours, and so the pills cannot be stretched
 * vertically by the scroll container (see alignItems where they are rendered).
 */
const SEGMENT_HEIGHT = 44;

/** Empty-state glyph per segment — three identical icons read as a bug. */
const SEGMENT_EMPTY_ICON: Record<Segment, keyof typeof Ionicons.glyphMap> = {
  saved: 'bookmark-outline',
  liked: 'heart-outline',
  seen: 'eye-outline',
};

function sortEntries(entries: LibraryEntry[], sort: SortKey): LibraryEntry[] {
  const copy = [...entries];
  switch (sort) {
    case 'rating':
      // Unrated titles sink rather than sorting as 0 amongst real scores.
      return copy.sort((a, b) => (b.item.vote_average ?? -1) - (a.item.vote_average ?? -1));
    case 'year':
      return copy.sort((a, b) => (b.item.release_year ?? -1) - (a.item.release_year ?? -1));
    case 'title':
      return copy.sort((a, b) => a.item.title.localeCompare(b.item.title));
    default:
      // `selectWatchlist` etc. already return newest-first.
      return copy;
  }
}

function Chip({
  active,
  label,
  icon,
  onPress,
}: {
  active: boolean;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      haptic="selection"
      activeScale={0.93}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        borderRadius: R.pill,
        paddingHorizontal: 13,
        paddingVertical: 7,
        backgroundColor: active ? C.chipActive : C.chip,
      }}
    >
      {icon && <Ionicons name={icon} size={12} color={active ? C.accent : C.textSecondary} />}
      <AppText variant="caption" className={active ? 'text-brand' : 'text-txt-secondary'}>
        {label}
      </AppText>
    </PressableScale>
  );
}

/**
 * Stand-in for missing artwork.
 *
 * TMDB genuinely has no poster for a slice of its catalogue (older and
 * non-English titles most of all), and `imageUrl` returns null for those. The
 * cell used to render as a bare dark rectangle, which is indistinguishable from
 * an image that failed to load — so the title carries the identification
 * instead. `compact` drops the text for the 64px list thumbnail, where it
 * would be unreadable anyway.
 */
function PosterFallback({ title, compact }: { title: string; compact?: boolean }) {
  return (
    <View
      style={[
        StyleSheet.absoluteFillObject,
        {
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingHorizontal: 10,
          backgroundColor: C.surfaceRaised,
        },
      ]}
    >
      <Ionicons name="film-outline" size={compact ? 18 : 26} color={C.textTertiary} />
      {!compact && (
        <AppText variant="caption" numberOfLines={3} className="text-center text-txt-secondary">
          {title}
        </AppText>
      )}
    </View>
  );
}

/**
 * Poster with a fallback for BOTH failure modes.
 *
 * A null `poster_path` is known before render; a 404 or a dead connection is
 * only known once expo-image reports it, hence the local `failed` state. Both
 * land on the same placeholder.
 */
function Poster({
  uri,
  title,
  recyclingKey,
  compact,
}: {
  uri: string | null;
  title: string;
  recyclingKey?: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  if (!uri || failed) return <PosterFallback title={title} compact={compact} />;

  return (
    <Image
      source={{ uri }}
      style={StyleSheet.absoluteFillObject}
      contentFit="cover"
      transition={140}
      recyclingKey={recyclingKey}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * The user's library, rendered straight from the Zustand store — every swipe
 * lands here immediately, with no network round-trip.
 */
export default function WatchlistScreen() {
  const t = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();

  const library = useAppStore((s) => s.library);
  const removeFromLibrary = useAppStore((s) => s.removeFromLibrary);
  const [segment, setSegment] = useState<Segment>('saved');

  /*
    Deep link from the profile's "View All".

    The param is CONSUMED once applied. A tab screen stays mounted, so a param
    left in place would keep re-asserting itself: switch to Seen by hand, come
    back to this tab later, and a stale ?segment=liked would silently drag you
    off the segment you chose. Clearing it also means tapping the same
    "View All" twice works the second time, which it would not if the effect
    only fired on a CHANGED value.
  */
  const params = useLocalSearchParams<{ segment?: string }>();
  useEffect(() => {
    const target = params.segment;
    if (!target) return;
    if (SEGMENTS.some((s) => s.key === target)) setSegment(target as Segment);
    router.setParams({ segment: undefined });
  }, [params.segment, router]);
  const [sort, setSort] = useState<SortKey>('recent');
  const [mode, setMode] = useState<ViewMode>('grid');
  /*
    The title whose destination sheet is open, or null.

    Reclassification reuses SaveSheet rather than growing a second control:
    the sheet already knows which list a title is in, already routes an
    already-judged title through `reclassify` (which moves the entry WITHOUT
    re-weighting the taste vector), and already treats a tap on the current
    list as "remove". One component, one mental model, in the deck, the detail
    screen and here.
  */
  const [sheetItem, setSheetItem] = useState<MediaItemRow | null>(null);

  // Poster cells are sized in PIXELS from the measured width. The previous
  // implementation used `aspect-[2/3]` with `height: '100%'` on the image —
  // a percentage against an aspect-ratio-derived (indefinite) height, which
  // Yoga resolves to `auto`, letting the image render at its intrinsic size.
  const columns = width >= 720 ? 4 : 2;
  const cellWidth = Math.floor(
    (Math.min(width, 900) - EDGE * 2 - GUTTER * (columns - 1)) / columns,
  );
  const cellHeight = Math.round(cellWidth * 1.5);

  const entries = useMemo<LibraryEntry[]>(() => {
    const base =
      segment === 'saved'
        ? selectWatchlist(library)
        : segment === 'liked'
          ? selectLiked(library)
          : selectSeen(library);
    return sortEntries(base, sort);
  }, [library, segment, sort]);

  const counts = useMemo(
    () => ({
      saved: selectWatchlist(library).length,
      liked: selectLiked(library).length,
      seen: selectSeen(library).length,
    }),
    [library],
  );

  const open = useCallback(
    (entry: LibraryEntry) => {
      const media = entry.item;
      router.push({
        pathname: '/media/[id]',
        params: {
          id: String(media.tmdb_id),
          type: media.media_type,
          mediaItemId: media.id,
          title: media.title,
          poster: media.poster_path ?? '',
        },
      });
    },
    [router],
  );

  const remove = useCallback(
    (id: string) => {
      hapticWarning();
      removeFromLibrary(id);
    },
    [removeFromLibrary],
  );

  const move = useCallback((media: MediaItemRow) => setSheetItem(media), []);
  const closeSheet = useCallback(() => setSheetItem(null), []);

  const empty = EMPTY_COPY[segment];

  const renderGrid = useCallback(
    ({ item: entry }: { item: LibraryEntry }) => (
      <GridCell
        entry={entry}
        width={cellWidth}
        height={cellHeight}
        onOpen={open}
        onRemove={remove}
        onMove={move}
      />
    ),
    [cellWidth, cellHeight, open, remove, move],
  );

  const renderRow = useCallback(
    ({ item: entry }: { item: LibraryEntry }) => (
      <ListRow entry={entry} onOpen={open} onRemove={remove} onMove={move} />
    ),
    [open, remove, move],
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      {/*
        Header in the Phase 1-3 idiom: circular icon chip, then the title, with
        the view toggle held at the logical end. Same shape as the Discover
        header, so moving between tabs does not feel like moving between apps.
      */}
      <View style={{ paddingHorizontal: EDGE }}>
        <View className="flex-row items-center" style={{ gap: SPACE.md }}>
          <View
            style={{
              width: SECTION_ICON.size,
              height: SECTION_ICON.size,
              borderRadius: SECTION_ICON.radius,
              backgroundColor: C.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="bookmark" size={18} color={C.text} />
          </View>

          <AppText variant="title" className="flex-1" numberOfLines={1}>
            {t('watchlist.title')}
          </AppText>

          <PressableScale
            onPress={() => setMode((m) => (m === 'grid' ? 'list' : 'grid'))}
            haptic="selection"
            activeScale={0.88}
            accessibilityRole="button"
            accessibilityLabel={t(mode === 'grid' ? 'watchlist.viewList' : 'watchlist.viewGrid')}
            style={{
              width: SECTION_ICON.size,
              height: SECTION_ICON.size,
              borderRadius: SECTION_ICON.radius,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: C.surface,
            }}
          >
            <Ionicons name={mode === 'grid' ? 'list' : 'grid'} size={17} color={C.textSecondary} />
          </PressableScale>
        </View>
      </View>

      {/*
        Segment pills.

        ── Why this ScrollView sits OUTSIDE the padded header ────────────────
        It used to be nested inside the `paddingHorizontal: EDGE` wrapper,
        which makes the SCROLL VIEWPORT itself 2 x EDGE narrower than the
        screen. The three Hebrew labels plus their counts came to almost
        exactly the width that left, so the row fitted only by luck — a
        three-digit count or a longer translation pushed the last pill past the
        clip boundary, where it could be neither read nor tapped.

        Going full-bleed and moving the inset into `contentContainerStyle`
        fixes it properly: the first and last pills still line up with the
        title above, but the row can now scroll rather than be cut off.

        `alignItems: 'center'` is load-bearing as well. A content container
        defaults to `stretch` on the cross axis, so any extra height in the
        row gets absorbed by the children — which is exactly how a selected
        pill ends up a tall slab beside its neighbours instead of a capsule.

        RTL needs nothing special: React Native mirrors row layout and the
        horizontal scroll origin natively, so the pills read right-to-left and
        the row already starts at the right edge. Reversing the array or
        forcing an initial scroll offset would double-correct it.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        directionalLockEnabled
        style={{ flexGrow: 0 }}
        contentContainerStyle={{
          gap: 6,
          paddingHorizontal: EDGE,
          paddingVertical: 16,
          alignItems: 'center',
        }}
      >
        {/*
          Glass segment bar. Wrapped AROUND the pills rather than replacing the
          ScrollView: the comment above records a real overflow bug with Hebrew
          labels, so the scroll safety net stays and the glass is purely the
          surface it sits on.
        */}
        <GlassView tone="chip" className="flex-row items-center rounded-full" style={{ padding: 4, gap: 6 }}>
        {SEGMENTS.map((item) => {
          const active = segment === item.key;
          const count = counts[item.key];
          return (
            <PressableScale
              key={item.key}
              onPress={() => setSegment(item.key)}
              haptic="selection"
              activeScale={0.95}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                height: SEGMENT_HEIGHT,
                paddingHorizontal: 16,
                borderRadius: SEGMENT_HEIGHT / 2,
                // Inactive pills are transparent so the glass bar reads as one
                // surface with a selected slot, not three stacked chips.
                backgroundColor: active ? C.chipActive : 'transparent',
              }}
            >
              <Ionicons name={item.icon} size={14} color={active ? C.accent : C.textSecondary} />
              <AppText variant="caption" numberOfLines={1} className={active ? 'text-brand' : ''}>
                {t(item.label)}
              </AppText>
              {/* The count is its own chip rather than digits appended to the
                  label. A number glued onto Hebrew with a plain space reorders
                  unpredictably under bidi, and it stopped the pill hugging its
                  content cleanly. */}
              {count > 0 && (
                <View
                  style={{
                    minWidth: 18,
                    paddingHorizontal: 4,
                    paddingVertical: 1,
                    borderRadius: 999,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: active ? C.accentSoft : 'rgba(255,255,255,0.07)',
                  }}
                >
                  <AppText
                    variant="label"
                    className={active ? 'text-brand' : 'text-txt-secondary'}
                  >
                    {count}
                  </AppText>
                </View>
              )}
            </PressableScale>
          );
        })}
        </GlassView>
      </ScrollView>

      {/* Sort row — hidden when there's nothing to sort. */}
      {entries.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          directionalLockEnabled
          // Same two guards as the segment row above: flexGrow keeps the strip
          // from claiming leftover column height, alignItems stops the chips
          // being stretched to fill it.
          style={{ flexGrow: 0 }}
          contentContainerStyle={{
            gap: 8,
            paddingHorizontal: EDGE,
            paddingTop: 12,
            alignItems: 'center',
          }}
        >
          <View className="flex-row items-center gap-1.5 pe-1">
            <Ionicons name="swap-vertical" size={12} color={C.textTertiary} />
            <AppText variant="caption">{t('watchlist.sortBy')}</AppText>
          </View>
          {SORTS.map((option) => (
            <Chip
              key={option.key}
              active={sort === option.key}
              label={t(option.label)}
              onPress={() => setSort(option.key)}
            />
          ))}
        </ScrollView>
      )}

      {entries.length === 0 ? (
        <View className="flex-1 items-center justify-center" style={{ paddingHorizontal: SPACE.xxl }}>
          <GlassView
            tone="panel"
            className="items-center"
            style={{ borderRadius: R.sheet, padding: SPACE.xxl, gap: SPACE.md }}
          >
            <Ionicons name={SEGMENT_EMPTY_ICON[segment]} size={40} color={C.accent} />

            <AppText variant="subtitle" className="text-center">
              {t(empty.title)}
            </AppText>
            <AppText variant="body" className="text-center">
              {t(empty.body)}
            </AppText>

            {/* An empty library is a dead end without this — the copy tells you
                to go swipe, so the screen should be able to take you there. */}
            <PressableScale
              onPress={() => router.push('/')}
              haptic="medium"
              accessibilityRole="button"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: SPACE.sm,
                marginTop: SPACE.sm,
                backgroundColor: C.accent,
                borderRadius: R.pill,
                paddingHorizontal: 28,
                paddingVertical: 13,
                ...SHADOW.accent,
              }}
            >
              <Ionicons name="flame" size={16} color={C.onAccent} />
              {/*
                C.onAccent, not `text-brand`. `text-brand` resolves to the same
                cyan as this button's fill; it silently does not apply here and
                the label falls back to white, which measures ~2.3:1 against
                #00B8D9 — below AA. onAccent is the token that exists for ink
                on an accent surface and gives ~11:1.
              */}
              <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
                {t('watchlist.discover')}
              </AppText>
            </PressableScale>
          </GlassView>
        </View>
      ) : (
        <FlatList
          // Remounts the list when the column count changes — FlatList cannot
          // change `numColumns` on an existing instance.
          key={`${mode}-${columns}`}
          data={entries}
          keyExtractor={(entry) => entry.item.id}
          numColumns={mode === 'grid' ? columns : 1}
          columnWrapperStyle={mode === 'grid' ? { gap: GUTTER } : undefined}
          contentContainerStyle={{
            gap: mode === 'grid' ? 16 : 10,
            paddingHorizontal: EDGE,
            paddingTop: 16,
            paddingBottom: 110,
          }}
          showsVerticalScrollIndicator={false}
          renderItem={mode === 'grid' ? renderGrid : renderRow}
        />
      )}

      {/*
        Mounted only while a title is chosen, so the sheet costs nothing the
        rest of the time and always opens with fresh membership state.
      */}
      {sheetItem && <SaveSheet item={sheetItem} onClose={closeSheet} />}
    </SafeAreaView>
  );
}

/**
 * One poster cell.
 *
 * Memoised on the entry id and the measured cell size: the parent re-renders on
 * every store write (a swipe on the deck tab mutates the same `library`
 * object), and without this every visible cell re-rendered with it.
 */
const GridCell = memo(
  function GridCell({
    entry,
    width,
    height,
    onOpen,
    onRemove,
    onMove,
  }: {
    entry: LibraryEntry;
    width: number;
    height: number;
    onOpen: (entry: LibraryEntry) => void;
    onRemove: (id: string) => void;
    onMove: (media: MediaItemRow) => void;
  }) {
    const t = useT();
    const media = entry.item;
    const poster = imageUrl(media.poster_path, 'w342');

    /*
      The remove button is a SIBLING of the open target, not a child of it.
      Nesting one pressable inside another renders as a <button> inside a
      <button> on web, which is invalid HTML — React logs a hydration error and
      screen readers get a control they cannot describe. Keeping them siblings
      costs one wrapper View and makes each control independently focusable.
    */
    return (
      <View style={{ width }}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={media.title}
          haptic="selection"
          activeScale={0.94}
          onPress={() => onOpen(entry)}
          style={{
            width,
            height,
            borderRadius: 12,
            overflow: 'hidden',
            backgroundColor: C.surface,
          }}
        >
          <Poster uri={poster} title={media.title} recyclingKey={media.id} />
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.8)']}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 64 }}
          />

          {/* Reference grid badge: dark chip, lime star, top start. */}
          {media.vote_average != null && media.vote_average > 0 && (
            <View
              className="absolute top-2 start-2 flex-row items-center gap-1 rounded-full px-2 py-1"
              style={{ backgroundColor: 'rgba(0,0,0,0.66)' }}
            >
              <Ionicons name="star" size={11} color={C.accent} />
              <AppText variant="caption" className="text-white">
                {media.vote_average.toFixed(1)}
              </AppText>
            </View>
          )}

          <View className="absolute bottom-2 start-2">
            <AppText variant="caption" className="text-white/85">
              {media.media_type === 'tv' ? t('deck.series') : t('deck.movie')}
            </AppText>
          </View>
        </PressableScale>

        <PressableScale
          onPress={() => onRemove(media.id)}
          haptic="none"
          activeScale={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('watchlist.remove')}
          style={{
            position: 'absolute',
            top: 8,
            end: 8,
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: 'rgba(0,0,0,0.70)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="close" size={14} color={C.text} />
        </PressableScale>

        {/*
          Move-to-another-list, in the one free corner: the rating badge owns
          top-start, remove owns top-end, the media-type caption owns
          bottom-start. An EXPLICIT button rather than a long-press, because
          unlike the deck this screen has no primary action competing for the
          gesture and nothing here would ever teach a hidden one.

          `swap-horizontal` is left/right symmetric, so it needs none of the
          manual scaleX mirroring the directional Ionicons require under RTL.
        */}
        <PressableScale
          onPress={() => onMove(media)}
          haptic="light"
          activeScale={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('watchlist.move')}
          style={{
            position: 'absolute',
            bottom: 40,
            end: 8,
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: 'rgba(0,0,0,0.70)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="swap-horizontal" size={15} color={C.text} />
        </PressableScale>

        <AppText variant="caption" numberOfLines={1} className="mt-1.5 text-txt">
          {media.title}
        </AppText>
        {media.release_year != null && (
          <AppText variant="caption" numberOfLines={1}>
            {media.release_year}
          </AppText>
        )}
      </View>
    );
  },
  (prev, next) =>
    prev.entry.item.id === next.entry.item.id &&
    prev.width === next.width &&
    prev.height === next.height,
);

/** Compact row for list mode. Memoised for the same reason as GridCell. */
const ListRow = memo(
  function ListRow({
    entry,
    onOpen,
    onRemove,
    onMove,
  }: {
    entry: LibraryEntry;
    onOpen: (entry: LibraryEntry) => void;
    onRemove: (id: string) => void;
    onMove: (media: MediaItemRow) => void;
  }) {
    const t = useT();
    const genreLabel = useGenreLabel();
    const media = entry.item;
    const poster = imageUrl(media.poster_path, 'w185');

    // Sibling controls, not nested — see the note in GridCell.
    return (
      <View
        className="flex-row items-center"
        style={{
          gap: 16,
          borderRadius: 20,
          backgroundColor: C.surface,
          padding: 14,
        }}
      >
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={media.title}
          haptic="selection"
          activeScale={0.97}
          onPress={() => onOpen(entry)}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14 }}
        >
          <View
            style={{
              ...ROW_THUMB,
              borderRadius: 10,
              overflow: 'hidden',
              backgroundColor: C.bg,
            }}
          >
            <Poster uri={poster} title={media.title} recyclingKey={media.id} compact />
          </View>

          <View className="flex-1 gap-1">
            <AppText variant="bodyStrong" numberOfLines={2}>
              {media.title}
            </AppText>
            <AppText variant="caption" numberOfLines={1}>
              {[
                media.media_type === 'tv' ? t('deck.series') : t('deck.movie'),
                media.release_year != null ? String(media.release_year) : null,
                // Translated at RENDER. `item.genres` holds canonical ENGLISH
                // keys — that is the storage contract (src/i18n/genres.ts),
                // and printing the key raw put an English word in the middle
                // of a Hebrew row.
                media.genres[0] ? genreLabel(media.genres[0]) : null,
              ]
                .filter(Boolean)
                .join('  ·  ')}
            </AppText>
            {media.vote_average != null && media.vote_average > 0 && (
              <View className="flex-row items-center gap-1">
                <Ionicons name="star" size={11} color={C.accent} />
                <AppText variant="caption" className="text-txt">
                  {media.vote_average.toFixed(1)}
                </AppText>
              </View>
            )}
          </View>
        </PressableScale>

        {/* Move, then remove — reversible action before destructive one. */}
        <PressableScale
          onPress={() => onMove(media)}
          haptic="light"
          activeScale={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('watchlist.move')}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255,255,255,0.06)',
          }}
        >
          <Ionicons name="swap-horizontal" size={16} color={C.textSecondary} />
        </PressableScale>

        <PressableScale
          onPress={() => onRemove(media.id)}
          haptic="none"
          activeScale={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('watchlist.remove')}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255,255,255,0.06)',
          }}
        >
          <Ionicons name="close" size={15} color={C.textSecondary} />
        </PressableScale>
      </View>
    );
  },
  (prev, next) => prev.entry.item.id === next.entry.item.id,
);
