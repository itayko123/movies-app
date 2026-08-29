import { useMemo } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { SectionHeader } from '@/components/SectionHeader';
import { imageUrl } from '@/lib/tmdb';
import { useT, type TranslationKey, type Translator } from '@/i18n';
import { C, R, SPACE } from '@/theme/tokens';
import type { LibraryEntry } from '@/state/store';
import type { SwipeDirection } from '@/types/media';

/**
 * "Recent Activity", from reference `20.47.28.jpeg`.
 *
 * ── Where the data comes from ──────────────────────────────────────────────
 * There is no activity log in this app and no table to build one from. What
 * there IS: `LibraryEntry.at`, an epoch-ms stamp written on every judgement
 * and updated by `reclassify`. Sorting the library by it descending IS the
 * activity feed — real events, real times, no new state and no network.
 *
 * ── Why dislikes are excluded ──────────────────────────────────────────────
 * `library` holds every judgement including 'dislike', and those are invisible
 * everywhere else in the app — no segment lists them. Surfacing them only here
 * would make this panel a running feed of things the user rejected, which is
 * not what "activity" means to a person looking at their own profile, and the
 * reference's own empty copy describes positive actions. Passes still count
 * toward the taste vector; they just do not get a headline.
 */

/** Rows shown at once. Four fills the reference's card without scrolling. */
const MAX_ROWS = 4;
/** Row thumbnail. Fixed pixels — never percentage sizing. */
const THUMB = { width: 40, height: 60 } as const;

const ACTION_LABEL: Record<
  Extract<SwipeDirection, 'superlike' | 'like' | 'seen'>,
  { key: TranslationKey; icon: keyof typeof Ionicons.glyphMap; tint: string }
> = {
  superlike: { key: 'activity.superlike', icon: 'bookmark', tint: C.super },
  like: { key: 'activity.like', icon: 'heart', tint: C.like },
  seen: { key: 'activity.seen', icon: 'eye', tint: C.seen },
};

/**
 * Epoch ms → a phrase a person would actually say.
 *
 * Exported for the sake of being testable in isolation: the boundaries here
 * (a "day" is 24h of elapsed time, not a calendar rollover) are a deliberate
 * simplification, and one worth being able to pin down.
 *
 * Singular days and weeks get their OWN keys rather than an interpolated
 * count. Hebrew has no graceful "לפני 1 ימים", so 1 becomes "אתמול" and the
 * plural form is only ever asked to render 2 or more.
 */
export function relativeTime(at: number, now: number, t: Translator): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return t('time.now');

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutes', { count: minutes });

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hours', { count: hours });

  const days = Math.floor(hours / 24);
  if (days === 1) return t('time.yesterday');
  if (days < 7) return t('time.days', { count: days });

  const weeks = Math.floor(days / 7);
  if (weeks === 1) return t('time.lastWeek');
  return t('time.weeks', { count: weeks });
}

/** Most recent positive judgements, newest first. */
export function selectRecentActivity(
  library: Record<string, LibraryEntry>,
  limit = MAX_ROWS,
): LibraryEntry[] {
  return Object.values(library)
    .filter((entry) => entry.direction !== 'dislike')
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export function RecentActivity({ library }: { library: Record<string, LibraryEntry> }) {
  const t = useT();
  const router = useRouter();

  const entries = useMemo(() => selectRecentActivity(library), [library]);
  /*
    Captured ONCE per render rather than read inside the row loop. Calling
    Date.now() per row would let a render that straddles a minute boundary
    stamp two rows against different clocks, and the list is ordered by time —
    so the one case it breaks is exactly the one that looks wrong.
  */
  const now = Date.now();

  return (
    <View style={{ gap: SPACE.md }}>
      <SectionHeader icon="pulse" title={t('profile.activity')} />

      {entries.length === 0 ? (
        <GlassView
          className="items-center"
          style={{ borderRadius: R.card, padding: SPACE.xxl, gap: SPACE.sm }}
        >
          <Ionicons name="pulse-outline" size={32} color={C.accent} />
          <AppText variant="bodyStrong" className="text-center">
            {t('profile.activityEmpty')}
          </AppText>
          <AppText variant="caption" className="text-center">
            {t('profile.activityEmptyBody')}
          </AppText>
        </GlassView>
      ) : (
        <GlassView style={{ borderRadius: R.card, padding: SPACE.md, gap: SPACE.xs }}>
          {entries.map((entry) => {
            const media = entry.item;
            const action =
              ACTION_LABEL[entry.direction as keyof typeof ACTION_LABEL] ?? ACTION_LABEL.like;
            const poster = imageUrl(media.poster_path, 'w185');

            return (
              <PressableScale
                key={media.id}
                onPress={() =>
                  router.push({
                    pathname: '/media/[id]',
                    params: {
                      id: String(media.tmdb_id),
                      type: media.media_type,
                      mediaItemId: media.id,
                      title: media.title,
                      poster: media.poster_path ?? '',
                    },
                  })
                }
                haptic="selection"
                activeScale={0.98}
                accessibilityRole="button"
                accessibilityLabel={`${media.title} — ${t(action.key)}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: SPACE.md,
                  padding: SPACE.sm,
                  borderRadius: R.chip,
                }}
              >
                <View
                  style={{
                    ...THUMB,
                    borderRadius: 8,
                    overflow: 'hidden',
                    backgroundColor: C.surfaceRaised,
                  }}
                >
                  {poster && (
                    <Image
                      source={{ uri: poster }}
                      style={THUMB}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                      transition={160}
                      recyclingKey={media.id}
                    />
                  )}
                </View>

                <View className="flex-1" style={{ gap: 2 }}>
                  <AppText variant="bodyStrong" numberOfLines={1}>
                    {media.title}
                  </AppText>
                  <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
                    <Ionicons name={action.icon} size={12} color={action.tint} />
                    <AppText variant="caption" numberOfLines={1} className="flex-1">
                      {t(action.key)}
                    </AppText>
                  </View>
                </View>

                {/* Timestamp trails the row, so the eye scans title-first. */}
                <AppText variant="caption" numberOfLines={1}>
                  {relativeTime(entry.at, now, t)}
                </AppText>
              </PressableScale>
            );
          })}
        </GlassView>
      )}
    </View>
  );
}
