import { ScrollView, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { RegionChips } from '@/components/RegionSwitcher';
import { SELECTABLE_GENRES } from '@/lib/tmdb';
import { useT, type TranslationKey } from '@/i18n';
import { useGenreLabel } from '@/i18n/genres';
import { useAppStore, type MediaFormat } from '@/state/store';
import { C } from '@/theme/tokens';

const FORMATS: Array<{
  value: MediaFormat;
  label: TranslationKey;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { value: 'movie', label: 'onboarding.movies', icon: 'film' },
  { value: 'tv', label: 'onboarding.series', icon: 'tv' },
  { value: 'both', label: 'onboarding.both', icon: 'sparkles' },
];

/**
 * Categories that get their own icon + accent ahead of the plain genres.
 * Country is NOT here any more — it lives in the RegionSwitcher above, because
 * origin composes with genre rather than competing with it.
 */
const FEATURED: Array<{
  value: string;
  label: TranslationKey;
  icon: keyof typeof Ionicons.glyphMap;
}> = [{ value: 'Kids & Youth', label: 'filters.kids', icon: 'happy' }];

function Pill({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      haptic="selection"
      activeScale={0.92}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: active ? 'rgba(0,184,217,0.16)' : '#121826',
      }}
    >
      {icon && <Ionicons name={icon} size={12} color={active ? '#00B8D9' : '#94A3B8'} />}
      <AppText variant="caption" className={active ? 'text-brand' : 'text-txt-secondary'}>
        {label}
      </AppText>
    </PressableScale>
  );
}

/**
 * The Discover header's filter surface, in TWO scrollable rows.
 *
 * ── The layout history, because it constrains what can change here ─────────
 * Originally three stacked full-width bands (region row, format row, genre
 * row). Together with the title and ticker that put five bands of chrome above
 * a `flex-1` card, and since the card is the flex remainder, every band came
 * straight out of the poster — the card was squeezed to about a third of the
 * screen. Collapsing all three onto one line fixed the height but left region
 * and genre fighting for the same scroll track, so a user reaching for a genre
 * had to scroll past six flags first.
 *
 * The split here is the middle position: two rows, each with ONE job.
 *
 *   Row 1 — format toggle (pinned) + region chips. Both answer "what
 *           catalogue?", and the toggle stays pinned because it is the
 *           most-used control and must never scroll out of reach.
 *   Row 2 — genre pills. The longest list, and now the only thing on its
 *           track, so the first pill is always at the start.
 *
 * That costs ~36px against the one-line version and is still ~70px cheaper
 * than the original three bands.
 *
 * ── The format toggle labels its active option only ────────────────────────
 * A pinned control has to be narrow, but three icon-only buttons make "both"
 * unguessable. Showing the label on the SELECTED segment alone keeps the
 * current state readable in words while the other two cost an icon each.
 *
 * All of these write to `deckFilters`, which is part of the deck's identity —
 * so a tap purges the rendered cards and refetches (see useSwipeDeck).
 */
export function DeckFilterBar() {
  const t = useT();
  const genreLabel = useGenreLabel();
  const filters = useAppStore((s) => s.deckFilters);
  const preferences = useAppStore((s) => s.preferences);
  const setDeckFormat = useAppStore((s) => s.setDeckFormat);
  const setDeckGenre = useAppStore((s) => s.setDeckGenre);

  const activeFormat: MediaFormat = filters.format ?? preferences?.mediaType ?? 'both';

  return (
    <View className="gap-2">
      {/* ── Row 1: what catalogue — format + origin ────────────────────── */}
      <View className="flex-row items-center gap-2">
        {/* Pinned format toggle — never scrolls away. */}
        <GlassView className="flex-row rounded-full p-1" intensity={30}>
          {FORMATS.map((format) => {
            const active = activeFormat === format.value;
            return (
              <PressableScale
                key={format.value}
                onPress={() => setDeckFormat(format.value)}
                haptic="medium"
                activeScale={0.94}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={t(format.label)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                  borderRadius: 999,
                  paddingVertical: 7,
                  paddingHorizontal: active ? 11 : 9,
                  backgroundColor: active ? '#00B8D9' : 'transparent',
                  ...(active ? { boxShadow: '0px 4px 12px rgba(0,184,217,0.34)' } : null),
                }}
              >
                {/*
                  Ink on the fill, not white. This pill is the only SOLID
                  accent surface in the header — white on #00B8D9 measures
                  2.37:1, under the 4.5:1 AA floor for the label and the 3:1
                  floor for the glyph. C.onAccent takes both to 8.16:1.
                */}
                <Ionicons
                  name={format.icon}
                  size={14}
                  color={active ? C.onAccent : C.textSecondary}
                />
                {active && (
                  <AppText variant="caption" style={{ color: C.onAccent }}>
                    {t(format.label)}
                  </AppText>
                )}
              </PressableScale>
            );
          })}
        </GlassView>

        {/* Origin chips take the remaining width of row 1. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 8, alignItems: 'center', paddingVertical: 2 }}
          // Keeps the row swipeable without stealing the card's pan gesture.
          directionalLockEnabled
        >
          <RegionChips />
        </ScrollView>
      </View>

      {/* ── Row 2: which genre — its own track, so the first pill is always
             at the start rather than behind six flags. ─────────────────── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, alignItems: 'center', paddingVertical: 2 }}
        directionalLockEnabled
      >
        <Pill
          active={filters.genre === null}
          icon="sparkles"
          label={t('filters.forYou')}
          onPress={() => setDeckGenre(null)}
        />

        {FEATURED.map((entry) => {
          const active = filters.genre === entry.value;
          return (
            <Pill
              key={entry.value}
              active={active}
              icon={entry.icon}
              label={t(entry.label)}
              onPress={() => setDeckGenre(active ? null : entry.value)}
            />
          );
        })}

        {SELECTABLE_GENRES.filter((genre) => genre !== 'Kids & Youth').map((genre) => {
          const active = filters.genre === genre;
          return (
            <Pill
              key={genre}
              active={active}
              // Translated for display only — `genre` stays the canonical
              // English key that drives the query. See src/i18n/genres.ts.
              label={genreLabel(genre)}
              // Tapping the active pill clears it and returns to "For you".
              onPress={() => setDeckGenre(active ? null : genre)}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}
