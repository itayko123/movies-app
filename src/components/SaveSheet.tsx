import { useCallback, useMemo } from 'react';
import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  FadeIn,
  useReducedMotion,
} from 'react-native-reanimated';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { imageUrl } from '@/lib/tmdb';
import {
  selectLiked,
  selectSeen,
  selectWatchlist,
  useAppStore,
} from '@/state/store';
import { useT, type TranslationKey } from '@/i18n';
import type { MediaItemRow, SwipeDirection } from '@/types/media';
import { C, R, SHADOW, SPACE } from '@/theme/tokens';

/**
 * "Save to list" bottom sheet, built from reference (10).
 *
 * ── What the reference has that we do not ──────────────────────────────────
 * The reference models named lists — "Watchlist" and "Watched" as built-ins,
 * plus a Cinelists section for user-created lists, shown EMPTY in the only
 * screenshot we have. Custom lists need a store migration, new Supabase tables
 * and cloud-sync plumbing, so they are deferred (see the Phase 4 plan).
 *
 * The Cinelists section is therefore OMITTED rather than rendered empty. An
 * empty panel advertising a feature that does not exist is the same mistake as
 * a search icon that opens nothing.
 *
 * ── Two writes, and the difference matters ─────────────────────────────────
 * Choosing a list for a title the user has never judged is a NEW OPINION, so
 * it goes through `recordSwipe` and teaches the recommendation engine. Moving
 * a title that is already filed is BOOKKEEPING, so it goes through
 * `reclassify`, which updates the entry and syncs it but deliberately skips
 * the taste queue. Without that split, tidying your library would slowly skew
 * your recommendations toward whatever you tidy most.
 */

/** Reference (10) geometry, from the 738px capture (÷1.878 = pt). */
const POSTER_W = 76;
const POSTER_H = 114;
const ROW_MIN_H = 74;
const GRABBER_W = 48;

interface Destination {
  direction: Extract<SwipeDirection, 'superlike' | 'like' | 'seen'>;
  label: TranslationKey;
  icon: keyof typeof Ionicons.glyphMap;
}

/**
 * The three real destinations, in the order the deck's own action row uses
 * them, so the sheet never contradicts the muscle memory the buttons build.
 */
const DESTINATIONS: Destination[] = [
  { direction: 'superlike', label: 'save.toWatch', icon: 'bookmark' },
  { direction: 'like', label: 'save.liked', icon: 'heart' },
  { direction: 'seen', label: 'save.seen', icon: 'eye' },
];

export interface SaveSheetProps {
  item: MediaItemRow;
  onClose: () => void;
}

export function SaveSheet({ item, onClose }: SaveSheetProps) {
  const t = useT();
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const inert = Platform.OS === 'web' || reduceMotion;

  const library = useAppStore((s) => s.library);
  const recordSwipe = useAppStore((s) => s.recordSwipe);
  const reclassify = useAppStore((s) => s.reclassify);
  const removeFromLibrary = useAppStore((s) => s.removeFromLibrary);

  const current = library[item.id]?.direction ?? null;

  /** How many titles each list already holds — the sheet's honest sub-line. */
  const counts = useMemo(
    () => ({
      superlike: selectWatchlist(library).length,
      like: selectLiked(library).length,
      seen: selectSeen(library).length,
    }),
    [library],
  );

  const choose = useCallback(
    (direction: Destination['direction']) => {
      if (current === direction) {
        // Tapping the list a title is already in takes it out. The row says so
        // — an affordance that only ever adds leaves no way back from a mistap.
        removeFromLibrary(item.id);
        return;
      }
      if (current == null) recordSwipe(item, direction);
      else reclassify(item.id, direction);
      onClose();
    },
    [current, item, onClose, recordSwipe, reclassify, removeFromLibrary],
  );

  const poster = imageUrl(item.poster_path, 'w342');

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={t('save.title')}
      style={{ position: 'absolute', top: 0, left: 0, width, height, zIndex: 46 }}
    >
      {/* Backdrop. Tapping outside closes — the standard sheet contract, and
          the only dismissal that works before any animation has finished. */}
      <PressableScale
        onPress={onClose}
        haptic="light"
        activeScale={1}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.62)',
        }}
      />

      <Animated.View
        entering={inert ? undefined : FadeIn.duration(180)}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
      >
        <GlassView
          tone="sheet"
          style={{
            borderTopLeftRadius: R.sheet,
            borderTopRightRadius: R.sheet,
            paddingBottom: SPACE.xxl,
            ...SHADOW.raised,
          }}
        >
          {/* Grabber. Purely an affordance here — it signals "this is a sheet"
              even though dismissal is by backdrop tap. */}
          <View className="items-center" style={{ paddingTop: SPACE.md }}>
            <View
              style={{
                width: GRABBER_W,
                height: 4,
                borderRadius: 2,
                backgroundColor: C.textSecondary,
                opacity: 0.5,
              }}
            />
          </View>

          <ScrollView
            style={{ maxHeight: height * 0.72 }}
            contentContainerStyle={{ padding: SPACE.edge, gap: SPACE.xl }}
            showsVerticalScrollIndicator={false}
          >
            {/* ── Header block ──────────────────────────────────────────── */}
            <View className="flex-row" style={{ gap: SPACE.lg }}>
              <View
                style={{
                  width: POSTER_W,
                  height: POSTER_H,
                  borderRadius: R.media,
                  overflow: 'hidden',
                  backgroundColor: C.surfaceRaised,
                }}
              >
                {poster && (
                  <Image
                    source={{ uri: poster }}
                    style={{ width: POSTER_W, height: POSTER_H }}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={160}
                    recyclingKey={item.id}
                  />
                )}
              </View>

              <View className="flex-1" style={{ gap: SPACE.sm }}>
                <AppText variant="subtitle" numberOfLines={2} className="text-white">
                  {item.title}
                </AppText>

                {/* Same facts treatment as the swipe card: dimmed glyph,
                    white value. One vocabulary across the app. */}
                <View className="flex-row items-center" style={{ gap: SPACE.lg }}>
                  {item.vote_average != null && item.vote_average > 0 && (
                    <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
                      <Ionicons name="star" size={13} color={C.textSecondary} />
                      <AppText variant="bodyStrong" className="text-white">
                        {item.vote_average.toFixed(1)}
                      </AppText>
                    </View>
                  )}
                  {item.release_year != null && (
                    <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
                      <Ionicons name="calendar-outline" size={13} color={C.textSecondary} />
                      <AppText variant="bodyStrong" className="text-white">
                        {item.release_year}
                      </AppText>
                    </View>
                  )}
                </View>

                {item.overview && (
                  <AppText variant="caption" numberOfLines={3}>
                    {item.overview}
                  </AppText>
                )}
              </View>
            </View>

            {/* ── Destination rows ──────────────────────────────────────── */}
            <View style={{ gap: SPACE.md }}>
              {DESTINATIONS.map((destination) => {
                const active = current === destination.direction;
                return (
                  <PressableScale
                    key={destination.direction}
                    onPress={() => choose(destination.direction)}
                    haptic="medium"
                    activeScale={0.97}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={t(destination.label)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: SPACE.md,
                      minHeight: ROW_MIN_H,
                      paddingHorizontal: SPACE.lg,
                      paddingVertical: SPACE.md,
                      borderRadius: R.card,
                      // Accent FILL for the active row, exactly as the
                      // reference tints its highlighted list. No border.
                      backgroundColor: active ? C.accentSoft : C.surface,
                    }}
                  >
                    <Ionicons
                      name={destination.icon}
                      size={20}
                      color={active ? C.accent : C.textSecondary}
                    />

                    <View className="flex-1">
                      <AppText
                        variant="bodyStrong"
                        className={active ? 'text-brand' : 'text-white'}
                      >
                        {t(destination.label)}
                      </AppText>
                      <AppText variant="caption" numberOfLines={1}>
                        {active
                          ? t('save.tapToRemove')
                          : t('watchlist.count', { count: counts[destination.direction] })}
                      </AppText>
                    </View>

                    <Ionicons
                      name={active ? 'checkmark-circle' : 'add'}
                      size={active ? 24 : 26}
                      color={active ? C.accent : C.text}
                    />
                  </PressableScale>
                );
              })}
            </View>
          </ScrollView>
        </GlassView>
      </Animated.View>
    </View>
  );
}
