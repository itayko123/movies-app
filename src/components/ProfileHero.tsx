import { useMemo } from 'react';
import { Platform, View } from 'react-native';
import { Image } from 'expo-image';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { imageUrl } from '@/lib/tmdb';
import { BLUR, C, R, SECTION_ICON, SHADOW, SPACE } from '@/theme/tokens';
import type { LibraryEntry } from '@/state/store';

/**
 * Profile identity header, from reference `20.47.28.jpeg`.
 *
 * ── Why the artwork is a BLURRED POSTER and not a backdrop ─────────────────
 * The reference puts a wide 16:9 backdrop behind the identity block. We cannot
 * do that literally: `compactForLibrary` (store.ts) strips `backdrop_path` to
 * null on every library write, so no saved title carries one. Posters survive
 * that trim, but a 2:3 portrait stretched across a short wide band either
 * distorts or crops down to somebody's chin.
 *
 * Blurring resolves it. At this radius the poster stops being a picture of a
 * scene and becomes the COLOUR of one — which is what the reference band is
 * actually contributing at a glance, and it cannot be cropped wrongly because
 * there is no longer any subject to crop. Same technique the welcome screen
 * uses over its poster wall.
 *
 * ── Three states, never a blank box ────────────────────────────────────────
 * Artwork, or the accent wash, or the accent wash — a brand-new account with
 * an empty library gets a designed gradient rather than a grey rectangle. The
 * PosterWall 0ms rule: the band is painted before any image resolves, so a
 * slow network shows the wash and then warms into artwork.
 */

/** Band height. ~28% of the reference frame, held to a fixed pt value. */
const HERO_HEIGHT = 232;
/** Avatar disc — reference measures ~100px on a 738px capture (÷1.878). */
const AVATAR = 54;

/**
 * The title whose artwork becomes the wash.
 *
 * Most-recent POSITIVE judgement, not highest-rated: this band is a personal
 * space, and "the last thing you liked" changes as the app is used, where a
 * top-rated pick would sit frozen for months. Dislikes are excluded — being
 * greeted by the colours of something you rejected is the wrong welcome.
 */
export function pickHeroEntry(library: Record<string, LibraryEntry>): LibraryEntry | null {
  let best: LibraryEntry | null = null;
  for (const entry of Object.values(library)) {
    if (entry.direction === 'dislike') continue;
    if (!entry.item.poster_path) continue;
    if (best == null || entry.at > best.at) best = entry;
  }
  return best;
}

export interface ProfileHeroProps {
  library: Record<string, LibraryEntry>;
  /**
   * Status-bar inset, added to the band height.
   *
   * The reference runs artwork BEHIND the status bar, so the screen drops its
   * top safe-area edge and the hero absorbs the inset itself. Content stays
   * pinned to the bottom of the band, clear of the clock either way.
   */
  topInset: number;
  /** Display name, or null for a guest session. */
  name: string | null;
  /** Secondary line — plan status. */
  subtitle: string;
  isPremium: boolean;
  /** Upgrade CTA. Omitted entirely for premium accounts. */
  onUpgrade?: () => void;
  upgradeLabel: string;
  /** Accessible label for the avatar. */
  avatarLabel: string;
  /** Opens the settings route. */
  onSettings: () => void;
  settingsLabel: string;
}

export function ProfileHero({
  library,
  topInset,
  name,
  subtitle,
  isPremium,
  onUpgrade,
  upgradeLabel,
  avatarLabel,
  onSettings,
  settingsLabel,
}: ProfileHeroProps) {
  const entry = useMemo(() => pickHeroEntry(library), [library]);
  // w342 is plenty: it is about to be blurred past the point where any extra
  // detail could survive, so a larger fetch would be bytes spent on nothing.
  const poster = imageUrl(entry?.item.poster_path ?? null, 'w342');

  /** First letter of the display name, as the reference shows. */
  const initial = name?.trim()?.[0]?.toUpperCase() ?? null;

  /** Premium keeps the violet it already had; free keeps the accent. */
  const discTint = isPremium ? C.secondary : C.accent;
  const discFill = isPremium ? C.secondarySoft : C.accentSoft;

  return (
    // No width and no margins: the caller owns horizontal placement, because
    // only it knows what padding this band has to bleed back out of.
    <View style={{ height: HERO_HEIGHT + topInset, alignSelf: 'stretch' }}>
      {/* 1. The designed wash. Painted first and never removed, so it is what
             shows before artwork resolves AND for an empty library. */}
      <LinearGradient
        colors={[discFill, C.bg]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      {/* 2. Artwork, when there is any. */}
      {poster && (
        <Image
          source={{ uri: poster }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={240}
          recyclingKey={entry?.item.id}
          // Decorative: the name and plan carry the meaning here.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      )}

      {/* 3. The blur that turns a portrait poster into drifting colour.
             Android's blur implementation is heavier and reads stronger at the
             same number, so it takes the softer value — the same split the
             welcome screen makes. */}
      {poster && (
        <BlurView
          intensity={Platform.OS === 'android' ? BLUR.soft : BLUR.heavy}
          tint="dark"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          pointerEvents="none"
        />
      )}

      {/* 4. Scrim into the page. The band has to END in true black or the
             seam between hero and screen is visible as a hard edge. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.15)', 'rgba(0,0,0,0.55)', C.bg]}
        locations={[0, 0.55, 1]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        pointerEvents="none"
      />

      {/* 5. Identity, pinned to the bottom of the band as the reference does. */}
      <View
        style={{
          position: 'absolute',
          bottom: SPACE.lg,
          start: SPACE.edge,
          end: SPACE.edge,
          gap: SPACE.md,
        }}
      >
        <View className="flex-row items-center" style={{ gap: SPACE.md }}>
          <View
            accessibilityRole="image"
            accessibilityLabel={avatarLabel}
            style={{
              width: AVATAR,
              height: AVATAR,
              borderRadius: AVATAR / 2,
              backgroundColor: discFill,
              alignItems: 'center',
              justifyContent: 'center',
              ...SHADOW.card,
            }}
          >
            {initial ? (
              <AppText variant="title" style={{ color: discTint }}>
                {initial}
              </AppText>
            ) : (
              // No name yet — a glyph, never an empty circle.
              <Ionicons name="person" size={24} color={discTint} />
            )}
          </View>

          <View className="flex-1">
            <AppText variant="subtitle" numberOfLines={1}>
              {name ?? avatarLabel}
            </AppText>
            <AppText variant="caption" numberOfLines={2} className="mt-0.5">
              {subtitle}
            </AppText>
          </View>

          {/*
            Configuration lives behind this, per the reference. A SOLID accent
            disc rather than the neutral chip used elsewhere: it is the only
            control in the band, it sits on artwork whose colour is different
            for every user, and a translucent chip would disappear against a
            bright poster. Ink is C.onAccent — white on this fill measures
            2.37:1, which is the contrast bug fixed across the app in Phase 4.
          */}
          <PressableScale
            onPress={onSettings}
            haptic="selection"
            activeScale={0.88}
            accessibilityRole="button"
            accessibilityLabel={settingsLabel}
            style={{
              width: SECTION_ICON.size,
              height: SECTION_ICON.size,
              borderRadius: SECTION_ICON.radius,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: C.accent,
              ...SHADOW.accent,
            }}
          >
            <Ionicons name="settings-sharp" size={18} color={C.onAccent} />
          </PressableScale>
        </View>

        {onUpgrade && (
          <PressableScale
            onPress={onUpgrade}
            haptic="medium"
            accessibilityRole="button"
            accessibilityLabel={upgradeLabel}
            style={{
              backgroundColor: C.accent,
              borderRadius: R.pill,
              paddingHorizontal: SPACE.xxl,
              paddingVertical: SPACE.md,
              alignSelf: 'flex-start',
              ...SHADOW.accent,
            }}
          >
            <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
              {upgradeLabel}
            </AppText>
          </PressableScale>
        )}
      </View>
    </View>
  );
}
