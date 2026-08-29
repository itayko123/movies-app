import { useCallback } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { SectionHeader } from '@/components/SectionHeader';
import { PosterTile, TILE, TILE_GAP } from '@/components/PosterTile';
import { SPACE } from '@/theme/tokens';
import type { LibraryEntry } from '@/state/store';
import type { MediaDraft } from '@/lib/tmdb';
import type { MediaItemRow } from '@/types/media';

/**
 * A horizontal shelf of saved titles, from reference `20.47.28 (1).jpeg`.
 *
 * ── Reused rather than rebuilt ─────────────────────────────────────────────
 * `PosterTile` already carries the fixed-pixel-size fix (the bug where an
 * aspect-ratio parent made Yoga resolve the image height to `auto` and expo-
 * image rendered at intrinsic resolution) and the hero-handoff measurement
 * that makes the detail screen fly in from the tapped tile. `MediaItemRow` is
 * a structural superset of `MediaDraft`, so library entries drop straight in
 * and both behaviours come along for free.
 *
 * ── The row hides itself when empty ────────────────────────────────────────
 * Same call as the Cineheads row in Phase 2: an empty rail under a heading is
 * worse than no heading. There is no honest fallback here either — you cannot
 * fill "titles you liked" with popular titles and still call it that. A brand
 * new account therefore sees no shelves, which is correct: Recent Activity's
 * empty state is directly above and already says what to do.
 */

export interface LibraryRowProps {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  entries: LibraryEntry[];
  /** Watchlist segment this shelf's "View All" opens. */
  segment: 'saved' | 'liked' | 'seen';
  viewAllLabel: string;
  /** Cap. The shelf is a teaser; "View All" is the complete list. */
  limit?: number;
}

const DEFAULT_LIMIT = 10;

export function LibraryRow({
  title,
  icon,
  entries,
  segment,
  viewAllLabel,
  limit = DEFAULT_LIMIT,
}: LibraryRowProps) {
  const router = useRouter();

  const open = useCallback(
    (draft: MediaDraft) => {
      // Cast back: the shelf only ever renders MediaItemRow, and the library
      // id is what the detail screen needs to update the existing entry
      // instead of creating a duplicate.
      const media = draft as MediaItemRow;
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

  const viewAll = useCallback(() => {
    router.push({ pathname: '/watchlist', params: { segment } });
  }, [router, segment]);

  if (entries.length === 0) return null;

  return (
    <View style={{ gap: SPACE.md }}>
      <SectionHeader icon={icon} title={title} action={viewAllLabel} onAction={viewAll} />

      {/*
        Full-bleed: the shelf is bled out of the screen's horizontal padding
        and pays it back as contentContainer padding instead, so tiles can
        scroll past the edge rather than stopping short of it.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -SPACE.edge }}
        contentContainerStyle={{ gap: TILE_GAP, paddingHorizontal: SPACE.edge }}
      >
        {entries.slice(0, limit).map((entry) => (
          <PosterTile key={entry.item.id} item={entry.item} size={TILE} onPress={open} />
        ))}
      </ScrollView>
    </View>
  );
}

