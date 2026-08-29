import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { LogoMark } from '@/components/AnimatedLogo';
import { CineheadsRow } from '@/components/CineheadsRow';
import { CollectionCarousel } from '@/components/CollectionCarousel';
import { GlassView } from '@/components/GlassView';
import { HeroCarousel } from '@/components/HeroCarousel';
import {
  PosterTile,
  HERO_TILE,
  TILE,
  TILE_EDGE as EDGE,
  TILE_GAP as GAP,
} from '@/components/PosterTile';
import { PressableScale } from '@/components/PressableScale';
import { SectionHeader } from '@/components/SectionHeader';
import { Skeleton } from '@/components/Skeleton';
import { useCollections, type Collection } from '@/hooks/useCollections';
import { useRecommendations, type RecommendationRow } from '@/hooks/useRecommendations';
import { type MediaDraft } from '@/lib/tmdb';
import { useT } from '@/i18n';
import { useAppStore, type MediaFormat, type PersonRole } from '@/state/store';
import { C, R, SPACE } from '@/theme/tokens';

/** Titles promoted from the top-picks shelf into the hero carousel. */
const HERO_COUNT = 5;

function Shelf({
  row,
  hero,
  onOpen,
}: {
  row: RecommendationRow;
  hero: boolean;
  onOpen: (item: MediaDraft) => void;
}) {
  const t = useT();
  const size = hero ? HERO_TILE : TILE;
  const stride = size.width + GAP;

  const renderItem = useCallback(
    ({ item }: { item: MediaDraft }) => (
      <PosterTile item={item} size={size} onPress={onOpen} />
    ),
    [size, onOpen],
  );

  return (
    // NOTE: deliberately NOT a Reanimated `entering` animation. Layout
    // animations hide the element until the animation runs, and Reanimated is
    // inert under react-native-web here — the shelves rendered their posters
    // but every label stayed invisible. Content visibility must never depend
    // on an animation completing.
    <View className="gap-3.5">
      <View className="px-5 gap-1.5">
        <View className="flex-row items-baseline justify-between">
          <AppText variant="subtitle" numberOfLines={1} className="flex-1">
            {t(row.titleKey, row.titleParams)}
          </AppText>
          <AppText variant="caption" className="ms-3">
            {row.items.length}
          </AppText>
        </View>

        {/*
          The shelf's justification, in plain language and from real counts.
          "For You" is otherwise indistinguishable from a random list — showing
          the actual evidence is what makes it read as a recommendation rather
          than filler.
        */}
        <View className="flex-row items-center gap-1.5">
          <Ionicons name="sparkles" size={11} color="#00B8D9" />
          <AppText variant="caption" numberOfLines={2} className="flex-1 text-txt-secondary">
            {t(row.reason.key, row.reason.params)}
          </AppText>
        </View>
      </View>

      <FlatList
        horizontal
        data={row.items.slice(0, 20)}
        keyExtractor={(item) => `${item.media_type}-${item.tmdb_id}`}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: EDGE, gap: GAP }}
        // Every tile is the same fixed size, so the list can skip measurement
        // entirely and scroll without layout jitter.
        getItemLayout={(_data, index) => ({
          length: stride,
          offset: stride * index,
          index,
        })}
        snapToInterval={stride}
        decelerationRate="fast"
        initialNumToRender={4}
        windowSize={5}
        removeClippedSubviews
      />
    </View>
  );
}

/**
 * The Movies / Shows segmented control, matching the reference's two pills.
 *
 * ── Why two pills express three states ─────────────────────────────────────
 * `MediaFormat` is 'movie' | 'tv' | 'both', and the reference shows exactly two
 * chips. Rendering only two options while the stored value can be 'both' would
 * leave a real state with NO pill lit, which reads as a bug. So the pair is
 * read as multi-select, the way filter chips behave everywhere:
 *
 *     both  → both pills lit  ("no narrowing applied")
 *     movie → Movies lit
 *     tv    → Shows lit
 *
 * Tapping an inactive pill narrows to it; tapping the pill that is *already the
 * only* selection widens back to both. No hidden third chip, no dead state.
 *
 * ── This writes a SHARED setting ───────────────────────────────────────────
 * It sets `deckFilters.format`, the same value the deck's own filter bar owns,
 * because a user who narrows to Shows here expects Shows on the deck. The deck
 * defers the disruptive half of that change until it is on screen — see the
 * focus gate in useSwipeDeck. The hint below says so out loud rather than
 * letting the user discover it.
 */
function FormatToggle() {
  const t = useT();
  const format = useAppStore((s) => s.deckFilters.format);
  const setDeckFormat = useAppStore((s) => s.setDeckFormat);
  const preferences = useAppStore((s) => s.preferences);
  const active: MediaFormat = format ?? preferences?.mediaType ?? 'both';

  const [hintVisible, setHintVisible] = useState(false);

  // A confirmation, not a permanent label — it earns its space only just after
  // a change, then gets out of the way.
  useEffect(() => {
    if (!hintVisible) return;
    const timer = setTimeout(() => setHintVisible(false), 2600);
    return () => clearTimeout(timer);
  }, [hintVisible]);

  const choose = (target: 'movie' | 'tv') => {
    setDeckFormat(active === target ? 'both' : target);
    setHintVisible(true);
  };

  const OPTIONS = [
    { value: 'movie', label: t('discover.movies'), icon: 'film' },
    { value: 'tv', label: t('discover.shows'), icon: 'tv' },
  ] as const;

  return (
    <View style={{ gap: SPACE.sm }}>
      <View className="flex-row" style={{ gap: SPACE.sm }}>
        {OPTIONS.map((option) => {
          const on = active === option.value || active === 'both';
          return (
            <PressableScale
              key={option.value}
              onPress={() => choose(option.value)}
              haptic="selection"
              activeScale={0.94}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={option.label}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 7,
                height: 42,
                paddingHorizontal: 18,
                borderRadius: R.pill,
                backgroundColor: on ? C.chipActive : C.chip,
              }}
            >
              <Ionicons
                name={option.icon}
                size={15}
                color={on ? C.accent : C.textSecondary}
              />
              <AppText variant="label" className={on ? 'text-brand' : 'text-txt-secondary'}>
                {option.label}
              </AppText>
            </PressableScale>
          );
        })}
      </View>

      {hintVisible && (
        <AppText variant="caption" numberOfLines={1}>
          {t('discover.appliesToDeck')}
        </AppText>
      )}
    </View>
  );
}

/**
 * "Discover" — the recommendation engine's output surface.
 *
 * The deck collects signal; this screen spends it. Shelves are built from the
 * learned `genreWeights`, with a higher quality bar than the deck (see
 * useRecommendations).
 *
 * Named "Discover" as of Phase 2 (the card stack became "Swipe"): browsing a
 * curated surface is what the word describes, and it matches the reference.
 *
 * The header's trailing corner held nothing for two phases, deliberately: a
 * magnifying glass that opened a mood picker, or a funnel duplicating the
 * toggle directly beneath it, would each have promised something the corner
 * could not deliver. The condition set then was "until there is a real text
 * search behind it" — `app/search.tsx` is that search, so the icon goes in now
 * and opens it. It is a route, not a sheet: search has its own scope toggle and
 * result grid, which do not belong crammed into this header.
 */
export default function ForYouScreen() {
  const t = useT();
  const router = useRouter();
  const { rows, isLoading, isError, refetch } = useRecommendations();

  /**
   * The hero is promoted OUT of the top-picks shelf, not fetched separately.
   *
   * A second query for "featured" titles would either duplicate the shelf
   * beneath it or need its own ranking rule to avoid doing so; taking the best
   * few off the top of the strongest shelf gets a hero for no extra request
   * and keeps one ranking in charge of the whole screen.
   */
  const heroItems = useMemo(
    () => (rows[0]?.items ?? []).filter((item) => Boolean(item.backdrop_path)).slice(0, HERO_COUNT),
    [rows],
  );

  /**
   * ...and removed from the shelf, so nothing appears twice on one screen. The
   * shelf keeps its remaining titles rather than disappearing: it is still the
   * best-of row, just minus the handful now shown large above it.
   */
  const shelfRows = useMemo(() => {
    if (heroItems.length === 0) return rows;
    const promoted = new Set(heroItems.map((item) => `${item.media_type}:${item.tmdb_id}`));
    return rows.map((row, index) =>
      index === 0
        ? {
            ...row,
            items: row.items.filter(
              (item) => !promoted.has(`${item.media_type}:${item.tmdb_id}`),
            ),
          }
        : row,
    );
  }, [rows, heroItems]);

  const collections = useCollections(rows);

  const openCollection = useCallback(
    (collection: Collection) => {
      router.push({ pathname: '/collection/[id]', params: { id: collection.id } });
    },
    [router],
  );

  const openPerson = useCallback(
    (person: { id: number; name: string; role: PersonRole }) => {
      router.push({
        pathname: '/person/[id]',
        params: { id: String(person.id), name: person.name, role: person.role },
      });
    },
    [router],
  );

  const openDetail = useCallback(
    (item: MediaDraft) => {
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

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      {/*
        Reference header: mark, title, nothing else — then straight into the
        filter pills. The taste subtitle that used to sit here is gone on
        purpose: every shelf already carries its own "why you're seeing this"
        line, so a second summary at the top was saying it twice.
      */}
      <View style={{ paddingHorizontal: SPACE.edge, gap: SPACE.lg, paddingBottom: SPACE.xs }}>
        <View className="flex-row items-center" style={{ gap: SPACE.md }}>
          <LogoMark size={36} />
          <AppText variant="title" className="flex-1" numberOfLines={1}>
            {t('tabs.discover')}
          </AppText>
          <PressableScale
            // `.expo/types/router.d.ts` is GENERATED and only learns about a new
            // route when the Expo dev server next runs, so a freshly added screen
            // is not yet in the Href union. The cast is the standard bridge for
            // that gap; it disappears on the next type generation.
            onPress={() => router.push('/search' as never)}
            haptic="light"
            accessibilityRole="button"
            accessibilityLabel={t('search.placeholder')}
            style={{ padding: SPACE.xs }}
          >
            <Ionicons name="search" size={22} color={C.text} />
          </PressableScale>
        </View>

        <FormatToggle />
      </View>

      {isLoading ? (
        <ScrollView
          contentContainerStyle={{ paddingTop: 16, paddingBottom: 120, gap: 24 }}
          showsVerticalScrollIndicator={false}
        >
          {[0, 1, 2].map((row) => (
            <View key={row} className="gap-3.5">
              <Skeleton className="h-5 w-48 rounded-lg mx-5" delay={row * 80} />
              <View style={{ flexDirection: 'row', paddingHorizontal: EDGE, gap: GAP }}>
                {[0, 1, 2].map((tile) => (
                  <Skeleton
                    key={tile}
                    className="rounded-2xl"
                    style={{ width: TILE.width, height: TILE.height }}
                    delay={row * 80 + tile * 60}
                  />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      ) : isError ? (
        <View className="flex-1 items-center justify-center gap-4 px-10">
          <Ionicons name="cloud-offline-outline" size={40} color="#64748B" />
          <AppText variant="body" className="text-center">
            {t('common.error')}
          </AppText>
          <PressableScale
            onPress={() => void refetch()}
            haptic="medium"
            accessibilityRole="button"
            style={{
              backgroundColor: '#00B8D9',
              borderRadius: 999,
              paddingHorizontal: 32,
              paddingVertical: 12,
            }}
          >
            <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
              {t('common.retry')}
            </AppText>
          </PressableScale>
        </View>
      ) : rows.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-10">
          <GlassView className="rounded-sheet p-8 items-center gap-3">
            <Ionicons name="sparkles" size={40} color="#00B8D9" />
            <AppText variant="subtitle" className="text-center">
              {t('forYou.emptyTitle')}
            </AppText>
            <AppText variant="body" className="text-center">
              {t('forYou.emptyBody')}
            </AppText>
            <PressableScale
              onPress={() => router.push('/')}
              haptic="medium"
              accessibilityRole="button"
              style={{
                backgroundColor: '#00B8D9',
                borderRadius: 999,
                paddingHorizontal: 32,
                paddingVertical: 12,
                marginTop: 4,
              }}
            >
              <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
                {t('forYou.startSwiping')}
              </AppText>
            </PressableScale>
          </GlassView>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingTop: 16, paddingBottom: 120, gap: 26 }}
          showsVerticalScrollIndicator={false}
        >
          <HeroCarousel items={heroItems} onOpen={openDetail} />

          {/*
            The Cinelists block. Sits directly under the hero, exactly as in the
            reference, because the two together are what give the screen a
            hierarchy — one big thing, then a row of medium things, then the
            shelves. Its header carries no "View All": there is nowhere for it
            to go that this row does not already show.
          */}
          {collections.length > 0 && (
            <View style={{ gap: SPACE.lg }}>
              <View style={{ paddingHorizontal: SPACE.edge }}>
                <SectionHeader icon="albums" title={t('discover.collections')} />
              </View>
              <CollectionCarousel collections={collections} onOpen={openCollection} />
            </View>
          )}

          {/*
            The people row. Third of the reference's three block types, and the
            one that makes the screen feel like it knows you — the taste engine
            made visible and browsable. Never hidden: it falls back to globally
            popular names for an account with no swipe history.
          */}
          <View style={{ gap: SPACE.lg }}>
            <View style={{ paddingHorizontal: SPACE.edge }}>
              <SectionHeader icon="sparkles" title={t('discover.people')} />
            </View>
            <CineheadsRow onOpen={openPerson} />
          </View>

          {shelfRows.map((row, index) => (
            <Shelf key={row.id} row={row} hero={index === 0} onOpen={openDetail} />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
