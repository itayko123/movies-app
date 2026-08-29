import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { useCommunityPulse } from '@/hooks/useCommunityPulse';
import { useT } from '@/i18n';

/** How long each line holds before the next one slides in. */
const HOLD_MS = 4200;

/**
 * "What the community is watching" — a one-line rotating ticker.
 *
 * ── Rotation, not a scrolling marquee ──────────────────────────────────────
 * A continuously translating marquee is the obvious reading of "auto-scrolling
 * ticker" and the wrong one here. It needs a per-frame driver, and this project
 * has proven twice over that per-frame drivers are not dependable on its
 * targets: Reanimated is inert under react-native-web, and requestAnimationFrame
 * does not fire at all when the page is not compositing. It also never stops
 * moving, which in the corner of a swipe-heavy screen is a permanent
 * distraction, and continuous horizontal motion in an RTL layout has to be
 * mirrored by hand or it reads backwards in Hebrew.
 *
 * Discrete rotation on a timer has none of those problems: setInterval fires
 * regardless of compositing, each line is static long enough to actually read,
 * and direction is a non-issue because nothing translates.
 *
 * ── It never invents activity ──────────────────────────────────────────────
 * With no backend there is no community data, and this says so rather than
 * showing plausible-looking numbers. See useCommunityPulse.
 */
export function CommunityTicker() {
  const t = useT();
  const { entries, source, isLoading } = useCommunityPulse(8);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (entries.length <= 1) return;
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % entries.length);
    }, HOLD_MS);
    return () => clearInterval(timer);
  }, [entries.length]);

  // Entries can shrink between refetches; clamp rather than render a hole.
  useEffect(() => {
    if (index >= entries.length) setIndex(0);
  }, [entries.length, index]);

  if (isLoading) return null;

  const current = entries[index];

  /*
    Copy is chosen by SOURCE, never by "do we have a title".

    `ticker.liked` asserts that N other people liked something in the last 24
    hours. That sentence may only be shown for `cloud` data. Trending entries
    describe themselves as trending — same slot, same rhythm, different and
    true claim. See PulseSource.
  */
  const line =
    current == null
      ? t('ticker.quiet')
      : source === 'trending'
        ? t('ticker.trending', { title: current.title })
        : t('ticker.liked', { count: current.like_count, title: current.title });

  const live = source === 'cloud' && entries.length > 0;
  const icon = live ? 'flame' : source === 'trending' ? 'flame-outline' : 'cloud-offline-outline';

  /**
   * Palette per source, so the banner's colour carries the same meaning its
   * copy does: warm for real people, violet for catalogue trending, grey when
   * there is nothing. Alphas are low on purpose — this sits directly above the
   * poster and must not compete with it.
   */
  const accent = live
    ? {
        gradient: ['rgba(251,146,60,0.20)', 'rgba(251,146,60,0.04)'] as const,
        border: 'rgba(251,146,60,0.28)',
        chip: 'rgba(251,146,60,0.22)',
        icon: '#FB923C',
      }
    : source === 'trending'
      ? {
          gradient: ['rgba(167,139,250,0.20)', 'rgba(167,139,250,0.04)'] as const,
          border: 'rgba(167,139,250,0.30)',
          chip: 'rgba(167,139,250,0.22)',
          icon: '#A78BFA',
        }
      : {
          gradient: ['rgba(255,255,255,0.06)', 'rgba(255,255,255,0.02)'] as const,
          border: 'rgba(148,163,184,0.13)',
          chip: 'rgba(255,255,255,0.08)',
          icon: '#64748B',
        };

  // Small uppercase label above the line. Gives the banner a hierarchy — what
  // this is, then what it says — instead of one undifferentiated grey string.
  // The eyebrow is also where the SOURCE is disclosed: the trending variant
  // names TMDB, so the line beneath it can be a bare title without ever
  // implying other users did something. See PulseSource.
  const eyebrow = source === 'trending' ? t('ticker.trendingLabel') : t('ticker.communityLabel');

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${t('ticker.title')}: ${line}`}
      style={{
        borderRadius: 14,
        overflow: 'hidden',
      }}
    >
      {/*
        Horizontal gradient rather than a flat fill: it puts the warmth behind
        the badge and lets it fall away under the text, so the eye lands on the
        icon first and the line reads as a caption rather than a status pill.
        `start`/`end` are on the X axis only — a vertical wash would fight the
        card gradients directly below it.
      */}
      <LinearGradient
        colors={accent.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingVertical: 8,
          paddingHorizontal: 10,
        }}
      >
        {/* Icon sits in its own tinted disc — at 13px on a gradient a bare
            glyph reads as an artefact rather than a deliberate mark. */}
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: accent.chip,
          }}
        >
          <Ionicons name={icon} size={13} color={accent.icon} />
        </View>

        <View className="flex-1">
          <AppText
            variant="caption"
            numberOfLines={1}
            style={{ color: accent.icon, fontSize: 10, letterSpacing: 0.6 }}
          >
            {eyebrow}
          </AppText>
          <AppText
            variant="caption"
            numberOfLines={1}
            className="text-txt"
            // Re-keyed per line so the text node is replaced rather than
            // mutated, which lets expo/RN treat it as new content for
            // accessibility announcements instead of a silent in-place edit.
            key={`${source}-${index}-${line}`}
          >
            {line}
          </AppText>
        </View>
      </LinearGradient>
    </View>
  );
}
