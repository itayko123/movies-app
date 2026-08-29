import { useMemo } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { SectionHeader } from '@/components/SectionHeader';
import { GlassView } from '@/components/GlassView';
import { TasteRadar } from '@/components/TasteRadar';
import { LevelBadge } from '@/components/LevelBadge';
import { QuestPanel } from '@/components/QuestPanel';
import { ProfileHero } from '@/components/ProfileHero';
import { RecentActivity } from '@/components/RecentActivity';
import { LibraryRow } from '@/components/LibraryRow';
import { useT } from '@/i18n';
import { useGenreLabel } from '@/i18n/genres';
import {
  useAppStore,
  selectRankedGenres,
  selectSaved,
  selectLiked,
  selectSeen,
  DEV_PREMIUM,
  type LibraryEntry,
} from '@/state/store';
import { C, R, SPACE } from '@/theme/tokens';

/**
 * One headline number, in the reference's tile shape.
 *
 * Reference `20.47.28.jpeg`: a dim icon and a dim label share the top line,
 * and the number sits alone underneath at display size, START-aligned. Three
 * departures from what this tile used to do, all of them the reference's:
 *
 *  1. START-aligned, not centred. Four centred tiles read as four unrelated
 *     badges; a shared start edge makes the grid scan as one table.
 *  2. The NUMBER is white, not tinted. Colour stays on the glyph. Four
 *     differently-coloured display numbers was the loudest thing on the
 *     screen and none of the colour carried information the icon did not.
 *  3. Label above, value below. The label is the question, the number is the
 *     answer, and the answer should be the thing the eye lands on.
 */
function StatTile({
  label,
  value,
  icon,
  tint,
}: {
  label: string;
  value: number;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
}) {
  return (
    <GlassView
      className="flex-1"
      style={{ borderRadius: R.card, padding: SPACE.lg, gap: SPACE.xs }}
    >
      <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
        <Ionicons name={icon} size={15} color={tint} />
        <AppText variant="caption" numberOfLines={1} className="flex-1">
          {label}
        </AppText>
      </View>
      <AppText variant="hero" numberOfLines={1}>
        {value}
      </AppText>
    </GlassView>
  );
}

/**
 * Horizontal bar showing a genre's learned weight.
 *
 * Bars are scaled against the strongest ABSOLUTE weight rather than each
 * being normalised to its own maximum, so the relative strength of one taste
 * against another is readable at a glance — which is the entire point of
 * showing the profile rather than just listing genre names.
 */
function TasteBar({ genre, weight, max }: { genre: string; weight: number; max: number }) {
  const positive = weight >= 0;
  const ratio = max > 0 ? Math.min(Math.abs(weight) / max, 1) : 0;
  return (
    <View className="gap-1.5">
      <View className="flex-row justify-between items-baseline">
        <AppText variant="bodyStrong" className={positive ? 'text-txt' : 'text-txt-tertiary'}>
          {genre}
        </AppText>
        <AppText variant="caption" className={positive ? 'text-like' : 'text-nope'}>
          {positive ? '+' : ''}
          {weight.toFixed(1)}
        </AppText>
      </View>
      <View className="h-2 rounded-full bg-elevated overflow-hidden">
        <View
          className="h-full rounded-full"
          style={{
            width: `${Math.max(ratio * 100, 4)}%`,
            backgroundColor: positive ? C.accent : C.nope,
          }}
        />
      </View>
    </View>
  );
}

export default function ProfileScreen() {
  const t = useT();
  const genreLabel = useGenreLabel();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const profile = useAppStore((s) => s.profile);
  const isPremium = useAppStore((s) => s.isPremium);
  const library = useAppStore((s) => s.library);
  const genreWeights = useAppStore((s) => s.genreWeights);
  const streak = useAppStore((s) => s.streak);

  /*
    Shelf contents. Sorted newest-first so a shelf leads with what the user
    most recently put there — the same ordering Recent Activity uses, and the
    only one where the first tile is not effectively arbitrary.
  */
  const shelves = useMemo(() => {
    const recent = (list: LibraryEntry[]) => [...list].sort((a, b) => b.at - a.at);
    return {
      saved: recent(selectSaved(library)),
      liked: recent(selectLiked(library)),
      seen: recent(selectSeen(library)),
    };
  }, [library]);

  const counts = useMemo(
    () => ({
      total: Object.keys(library).length,
      // Strict superlike count — the tile is labelled "Super likes" and sits
      // beside a "Likes" tile, so it must not use the To Watch superset.
      saved: selectSaved(library).length,
      liked: selectLiked(library).length,
      seen: selectSeen(library).length,
    }),
    [library],
  );

  const ranked = useMemo(() => selectRankedGenres(genreWeights).slice(0, 8), [genreWeights]);
  const maxWeight = useMemo(
    () => ranked.reduce((max, entry) => Math.max(max, Math.abs(entry.weight)), 0),
    [ranked],
  );

  /**
   * Radar axes: positive genres only, capped at 6.
   *
   * Negative weights are excluded on purpose — a radar plots magnitude from a
   * shared centre, so a strongly-disliked genre would render as a large spike
   * and read as a favourite. Dislikes stay in the signed bar list below.
   */
  const radarAxes = useMemo(
    () =>
      ranked
        .filter((entry) => entry.weight > 0)
        .slice(0, 6)
        .map((entry) => ({ label: genreLabel(entry.genre), value: entry.weight })),
    [ranked, genreLabel],
  );

  const favourites = ranked.filter((entry) => entry.weight > 0).slice(0, 5);

  // No top edge: the hero absorbs the status-bar inset itself, so its artwork
  // can run behind the clock exactly as the reference does.
  return (
    <SafeAreaView edges={[]} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: 120,
          gap: 22,
          width: '100%',
          maxWidth: 640,
          alignSelf: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        {/*
          Identity hero. Bled back out of the scroll container's horizontal
          padding and its top gap so the band reaches all three edges — a
          20pt gutter beside the artwork would read as a floating banner
          rather than the screen's header.
        */}
        {/* Horizontal bleed only. `gap` applies BETWEEN children, so as the
            first child the hero has no leading gap to cancel — a negative
            marginTop here just pushes the top of the band off-screen. */}
        <View style={{ marginHorizontal: -SPACE.edge }}>
          <ProfileHero
            topInset={insets.top}
            library={library}
            name={profile?.display_name ?? null}
            subtitle={
              (isPremium ? t('profile.premiumActive') : t('profile.freePlan')) +
              (isPremium && DEV_PREMIUM ? ` · ${t('profile.devUnlocked')}` : '')
            }
            isPremium={isPremium}
            onUpgrade={isPremium ? undefined : () => router.push('/paywall')}
            upgradeLabel={t('common.upgrade')}
            avatarLabel={t('profile.guest')}
            onSettings={() => router.push('/settings')}
            settingsLabel={t('profile.settings')}
          />
        </View>

        {/* Recent activity, above the numbers: what you just did is more
            interesting than a running total, and the reference orders it the
            same way. */}
        <RecentActivity library={library} />

        {/*
          Swipe counts as the reference's 2x2 grid.

          Two rows of two rather than a wrapping flex container: with `gap` and
          `flex-1` this gives exact halves at every width with no percentage
          maths, and it cannot reflow to 3+1 on a wide screen the way wrapping
          would. Four across (the previous layout) left each tile ~78pt wide,
          which is not enough for a Hebrew label beside a display number.
        */}
        <View className="gap-3">
          <SectionHeader icon="stats-chart" title={t('profile.stats')} />
          <View style={{ gap: SPACE.md }}>
            <View className="flex-row" style={{ gap: SPACE.md }}>
              <StatTile
                label={t('profile.totalSwipes')}
                value={counts.total}
                icon="layers"
                tint={C.accent}
              />
              <StatTile
                label={t('profile.superlikes')}
                value={counts.saved}
                icon="bookmark"
                tint={C.secondary}
              />
            </View>
            <View className="flex-row" style={{ gap: SPACE.md }}>
              <StatTile
                label={t('profile.likes')}
                value={counts.liked}
                icon="heart"
                tint={C.like}
              />
              <StatTile
                label={t('profile.seenCount')}
                value={counts.seen}
                icon="eye"
                tint={C.seen}
              />
            </View>
          </View>
        </View>

        {/*
          Content shelves, from reference `20.47.28 (1).jpeg`.

          Placement is deliberate. The reference runs identity → activity →
          numbers → content, and everything above this point is ABOUT the
          library while these two rows ARE the library. They sit before the
          streak/level/quest block because a person opening their profile is
          far more likely to be looking for a title they saved than for their
          XP — the gamification is a reason to come back, not a reason to open
          the screen.

          Seen has no shelf: it is already represented in the stats grid and in
          Recent Activity, and a third rail of the same shape would turn the
          screen into a wall of posters. It stays one tap away in the library
          tab. Each row hides itself when its segment is empty.
        */}
        <LibraryRow
          title={t('watchlist.tabSaved')}
          icon="bookmark"
          entries={shelves.saved}
          segment="saved"
          viewAllLabel={t('common.seeAll')}
        />
        <LibraryRow
          title={t('watchlist.tabLiked')}
          icon="heart"
          entries={shelves.liked}
          segment="liked"
          viewAllLabel={t('common.seeAll')}
        />

        {/* Swipe streak — the retention hook. Shows the "start" prompt at
            zero rather than a bare 0, which reads as failure. */}
        <GlassView className="rounded-3xl p-5 flex-row items-center gap-4">
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 26,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: streak.current >= 7 ? C.accentSoft : C.surface,
            }}
          >
            <Ionicons
              name="flame"
              size={24}
              color={streak.current >= 7 ? C.accent : streak.current > 0 ? C.streak : C.textTertiary}
            />
          </View>
          <View className="flex-1">
            <AppText variant="bodyStrong">
              {streak.current > 0
                ? t('streak.day', { count: streak.current })
                : t('streak.title')}
            </AppText>
            <AppText variant="caption" className="mt-0.5">
              {streak.current > 0
                ? t('streak.best', { count: streak.longest })
                : t('streak.start')}
            </AppText>
          </View>
        </GlassView>

        {/* Cinephile level — the long arc, sitting directly under the streak
            (the daily one) so the two retention loops read as a pair. */}
        <GlassView className="rounded-3xl p-5 gap-3">
          <SectionHeader icon="trophy" title={t('level.title')} />
          <LevelBadge />
        </GlassView>

        {/* Today's quests — the short arc. */}
        <QuestPanel />

        {/* Favourite genres — the headline of the taste profile. */}
        {favourites.length > 0 && (
          <View className="gap-3">
            <SectionHeader icon="heart" title={t('profile.topGenres')} />
            <View className="flex-row flex-wrap gap-2">
              {favourites.map((entry, index) => (
                <View
                  key={entry.genre}
                  className="flex-row items-center gap-1.5 rounded-full px-3.5 py-2"
                  style={{
                    backgroundColor: index === 0 ? C.accentSoft : C.surface,
                  }}
                >
                  {index === 0 && <Ionicons name="star" size={12} color={C.accent} />}
                  <AppText
                    variant="caption"
                    className={index === 0 ? 'text-brand' : 'text-txt-secondary'}
                  >
                    {genreLabel(entry.genre)}
                  </AppText>
                </View>
              ))}
            </View>
          </View>
        )}

        {/*
          Taste analysis. The radar shows the SHAPE of the profile (specialist
          vs generalist) which a sorted bar list cannot; the bars below it stay
          for the exact per-genre numbers.
        */}
        {radarAxes.length >= 3 && (
          <View className="gap-3">
            <SectionHeader icon="analytics" title={t('profile.tasteAnalysis')} />
            <GlassView className="rounded-3xl py-5 items-center">
              <TasteRadar
                axes={radarAxes}
                size={Math.min(width - 88, 280)}
                caption={t('profile.radarCaption', { count: radarAxes.length })}
              />
            </GlassView>
          </View>
        )}

        {/* Learned taste profile — the recommendation engine, made visible. */}
        <View className="gap-3">
          <SectionHeader icon="aperture" title={t('profile.tasteTitle')} />
          {ranked.length === 0 ? (
            <GlassView className="rounded-3xl p-6 items-center gap-2">
              <Ionicons name="pulse" size={26} color={C.textSecondary} />
              <AppText variant="body" className="text-center">
                {t('profile.tasteEmpty')}
              </AppText>
            </GlassView>
          ) : (
            <GlassView className="rounded-3xl p-5 gap-4">
              <AppText variant="caption">{t('profile.tasteHint')}</AppText>
              {ranked.map((entry) => (
                <TasteBar
                  key={entry.genre}
                  genre={genreLabel(entry.genre)}
                  weight={entry.weight}
                  max={maxWeight}
                />
              ))}
            </GlassView>
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}
