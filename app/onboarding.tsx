import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { GENRE_BACKDROPS, SELECTABLE_GENRES, imageUrl } from '@/lib/tmdb';
import { hapticLight, hapticSelection, hapticSuccess } from '@/lib/haptics';
import { useT } from '@/i18n';
import { useGenreLabel } from '@/i18n/genres';
import { useAppStore, type Preferences } from '@/state/store';
import { C } from '@/theme/tokens';

const MIN_GENRES = 2;

type MediaChoice = Preferences['mediaType'];

const MEDIA_CHOICES: Array<{ value: MediaChoice; icon: keyof typeof Ionicons.glyphMap }> = [
  { value: 'movie', icon: 'film' },
  { value: 'tv', icon: 'tv' },
  { value: 'both', icon: 'sparkles' },
];

/** Selection lift. Slower than the press spring so the two read as distinct. */
const SELECT_SPRING = { damping: 12, stiffness: 320, mass: 0.6 };

/**
 * Gradient stops for the scrim under the label.
 *
 * A backdrop is photographic and unpredictable, so white text over raw artwork
 * fails contrast constantly. The scrim is opaque enough at the bottom to
 * guarantee legibility regardless of what the still happens to contain.
 */
const SCRIM = ['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.92)'] as const;

interface GenreCardProps {
  id: string;
  label: string;
  /** Optional second line — used by the wide Israeli-content card. */
  sublabel?: string;
  backdropPath: string | undefined;
  selected: boolean;
  width: number;
  height: number;
  onToggle: (id: string) => void;
  accent?: boolean;
}

/**
 * One image-backed genre tile.
 *
 * Press feedback comes from PressableScale; the extra shared value here is the
 * SELECTION lift, which persists after the finger lifts and so cannot be
 * expressed by press state alone.
 */
function GenreCard({
  id,
  label,
  sublabel,
  backdropPath,
  selected,
  width,
  height,
  onToggle,
  accent,
}: GenreCardProps) {
  const chosen = useSharedValue(selected ? 1 : 0);

  // Driven by an effect rather than written during render — mutating a shared
  // value in the render phase is a side effect and misfires under StrictMode's
  // double-invoke.
  useEffect(() => {
    chosen.value = withSpring(selected ? 1 : 0, SELECT_SPRING);
  }, [selected, chosen]);

  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.03 * chosen.value }],
  }));

  return (
    <PressableScale
      onPress={() => onToggle(id)}
      haptic="selection"
      activeScale={0.94}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={{ width, height }}
    >
      {/* NativeWind classes are dropped on Reanimated components, so every
          visual is an explicit style on this animated child. */}
      <Animated.View
        style={[
          liftStyle,
          {
            flex: 1,
            borderRadius: 20,
            overflow: 'hidden',
            backgroundColor: '#121826',
            boxShadow: selected
              ? '0px 10px 26px rgba(0,184,217,0.38)'
              : '0px 6px 16px rgba(0,0,0,0.45)',
            elevation: selected ? 10 : 4,
          },
        ]}
      >
        {backdropPath && (
          <Image
            source={{ uri: imageUrl(backdropPath, 'w500') ?? undefined }}
            // Explicit fill, never percentage sizing: a percentage height
            // against a flex parent resolves to auto and the image renders at
            // its intrinsic resolution.
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            contentFit="cover"
            transition={220}
            cachePolicy="memory-disk"
          />
        )}

        <LinearGradient
          colors={SCRIM}
          locations={[0, 0.5, 1]}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />

        {/* Brand wash confirms selection even before the check mark is read. */}
        {selected && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,184,217,0.25)',
            }}
          />
        )}

        {selected && (
          <View className="absolute top-2 end-2 w-7 h-7 rounded-full bg-brand items-center justify-center">
            <Ionicons name="checkmark" size={17} color="#000000" />
          </View>
        )}

        {accent && !selected && (
          <View className="absolute top-2 end-2 rounded-full bg-black/70 px-2 py-0.5">
            <AppText variant="caption" className="text-brand">
              IL
            </AppText>
          </View>
        )}

        <View className="absolute bottom-0 start-0 end-0 px-3 pb-2.5">
          <AppText variant="bodyStrong" numberOfLines={2} className="text-white">
            {label}
          </AppText>
          {sublabel && (
            <AppText variant="caption" numberOfLines={2} className="text-white/80 mt-0.5">
              {sublabel}
            </AppText>
          )}
        </View>
      </Animated.View>
    </PressableScale>
  );
}

/**
 * Cold-start onboarding.
 *
 * Shown once, whenever no preferences are saved. The result is a HARD filter on
 * the deck (see resolveDeckQuery), not a hint — so this screen is worth the
 * visual weight: it is the single biggest lever the user has over what they see.
 */
export default function OnboardingScreen() {
  const t = useT();
  const genreLabel = useGenreLabel();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const setPreferences = useAppStore((s) => s.setPreferences);

  const [selected, setSelected] = useState<string[]>([]);
  const [mediaType, setMediaType] = useState<MediaChoice>('both');

  // Two columns on a phone, three once there's room (tablet / web).
  const columns = width >= 720 ? 3 : 2;
  const GUTTER = 12;
  const HORIZONTAL_PADDING = 24;
  const cardWidth =
    (Math.min(width, 760) - HORIZONTAL_PADDING * 2 - GUTTER * (columns - 1)) / columns;
  const cardHeight = Math.round(cardWidth * 0.68);

  const toggle = useCallback((id: string) => {
    hapticSelection();
    setSelected((current) =>
      current.includes(id) ? current.filter((g) => g !== id) : [...current, id],
    );
  }, []);

  // `id` stays the canonical English name (it keys the taste profile and the
  // TMDB catalogue); only `label` is translated. See src/i18n/genres.ts.
  const cards = useMemo(
    () =>
      SELECTABLE_GENRES.map((genre) => ({
        id: genre,
        label: genreLabel(genre),
        backdrop: GENRE_BACKDROPS[genre],
      })),
    [genreLabel],
  );

  const genres = selected;
  const canContinue = genres.length >= MIN_GENRES;

  const commit = (chosenGenres: string[]) => {
    setPreferences({ genres: chosenGenres, mediaType });
    hapticSuccess();
    router.replace('/');
  };

  return (
    <View className="flex-1 bg-app">
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 20,
          paddingHorizontal: HORIZONTAL_PADDING,
          paddingBottom: insets.bottom + 150,
          gap: 26,
          width: '100%',
          maxWidth: 760,
          alignSelf: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-2">
          <AppText variant="hero">{t('onboarding.title')}</AppText>
          <AppText variant="body">{t('onboarding.subtitle')}</AppText>
        </View>

        {/* Format */}
        <View className="gap-3">
          <AppText variant="subtitle">{t('onboarding.watching')}</AppText>
          <View className="flex-row gap-3">
            {MEDIA_CHOICES.map((choice) => {
              const active = mediaType === choice.value;
              const label =
                choice.value === 'movie'
                  ? t('onboarding.movies')
                  : choice.value === 'tv'
                    ? t('onboarding.series')
                    : t('onboarding.both');
              return (
                <PressableScale
                  key={choice.value}
                  onPress={() => setMediaType(choice.value)}
                  haptic="selection"
                  activeScale={0.94}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    gap: 6,
                    borderRadius: 16,
                    paddingVertical: 16,
                    backgroundColor: active ? 'rgba(0,184,217,0.16)' : '#121826',
                  }}
                >
                  <Ionicons name={choice.icon} size={22} color={active ? '#00B8D9' : '#94A3B8'} />
                  <AppText variant="bodyStrong" className={active ? 'text-brand' : ''}>
                    {label}
                  </AppText>
                </PressableScale>
              );
            })}
          </View>
        </View>

        {/*
          Country deliberately does NOT appear here.
          Origin is a top-level axis that composes with genre ("Korean
          thrillers"), so it lives in the RegionSwitcher in the Discover header
          where it can be changed at any moment — not baked into a one-time
          onboarding answer alongside genres it is not mutually exclusive with.
        */}

        {/* Genre grid */}
        <View className="gap-3">
          <View className="flex-row items-baseline justify-between">
            <AppText variant="subtitle">{t('onboarding.genres')}</AppText>
            <AppText variant="caption">
              {selected.length > 0
                ? t('onboarding.genresSelected', { count: selected.length })
                : t('onboarding.genresHint', { count: MIN_GENRES })}
            </AppText>
          </View>

          {/* A plain wrapping flex row rather than FlatList: 17 fixed-size
              tiles all render at once anyway, and nesting a VirtualizedList
              inside a ScrollView is an anti-pattern RN warns about. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GUTTER }}>
            {cards.map((card) => (
              <GenreCard
                key={card.id}
                id={card.id}
                label={card.label}
                backdropPath={card.backdrop}
                selected={selected.includes(card.id)}
                width={cardWidth}
                height={cardHeight}
                onToggle={toggle}
              />
            ))}
          </View>
        </View>
      </ScrollView>

      {/* Sticky footer */}
      <View
        className="absolute bottom-0 start-0 end-0 px-6 gap-2 bg-app"
        style={{ paddingBottom: insets.bottom + 16, paddingTop: 16 }}
      >
        <PressableScale
          onPress={() => commit(genres)}
          disabled={!canContinue}
          haptic="success"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canContinue }}
          style={{
            backgroundColor: '#00B8D9',
            borderRadius: 999,
            paddingVertical: 16,
            alignItems: 'center',
          }}
        >
          <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
            {t('onboarding.continue')}
          </AppText>
        </PressableScale>
        <PressableScale
          // Skipping still writes preferences (with no genres) so the gate is
          // satisfied and the user isn't asked again on every launch.
          onPress={() => commit([])}
          haptic="light"
          accessibilityRole="button"
          style={{ paddingVertical: 8, alignItems: 'center' }}
        >
          <AppText variant="caption">{t('onboarding.skip')}</AppText>
        </PressableScale>
      </View>
    </View>
  );
}
