import { useMemo } from 'react';
import type { RecommendationRow } from '@/hooks/useRecommendations';
import type { MediaDraft } from '@/lib/tmdb';
import { useT } from '@/i18n';

/**
 * The "Cinelists" block, built from shelves we already have.
 *
 * The reference fills this row with user-curated public lists. We have no
 * public-lists table and no follow graph, and inventing follower counts for a
 * commercial app is not on the table — so the row keeps the reference's SHAPE
 * and carries our real recommendation shelves instead: Hidden Gems, Israeli
 * picks, top-rated binge, "because you like X".
 *
 * This is pure derivation. It issues NO network calls of its own: every title
 * here is already in the react-query cache that painted the shelves below.
 *
 * Shelves are selected by SHAPE rather than by hard-coded id, which matters
 * more than it looks: Step 1 made several shelves conditional on the
 * Movies/Shows filter — the binge shelf disappears entirely under Movies —
 * so a list of expected ids would quietly produce empty cards. Anything with
 * enough titles to fill a strip qualifies; anything that does not, drops out.
 */

/** Images stitched into one card's filmstrip. */
export const STRIP_TILES = 3;

/** More than four and the dots stop being countable at a glance. */
const MAX_COLLECTIONS = 4;

export interface Collection {
  id: string;
  title: string;
  /** How many titles the collection holds, for the card's sub-line. */
  count: number;
  items: MediaDraft[];
}

export function useCollections(rows: RecommendationRow[]): Collection[] {
  const t = useT();

  return useMemo(() => {
    return (
      rows
        // Row 0 is top picks, which is already the hero's source and the first
        // shelf on screen. Featuring it a third time would be padding.
        .slice(1)
        .filter((row) => row.items.length >= STRIP_TILES)
        .slice(0, MAX_COLLECTIONS)
        .map((row) => ({
          id: row.id,
          title: t(row.titleKey, row.titleParams),
          count: row.items.length,
          items: row.items,
        }))
    );
  }, [rows, t]);
}
