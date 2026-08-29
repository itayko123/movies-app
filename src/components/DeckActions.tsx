import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { PressableScale } from '@/components/PressableScale';
import { C } from '@/theme/tokens';
import type { SwipeDirection } from '@/types/media';

/**
 * Geometry measured off the original Cineswipe reference screenshots
 * (738px-wide captures ÷ 1.878 = pt).
 *
 *   reference disc diameters : 49 / 46 / 46 / 52 pt   → near-uniform
 *   reference gap            : ~10 pt
 *   reference glyph          : ~47% of its disc
 *
 * Two things the previous build got wrong, and why they mattered:
 *
 *  1. SIZE CONTRAST. It used 66 / 54 / 54 / 66 — a 1.22 ratio against the
 *     reference's 1.13, on discs that were simply too big. The row read as
 *     two buttons with two afterthoughts instead of one balanced control bar.
 *  2. DISC COLOUR. It tinted the watchlist disc olive. In the reference EVERY
 *     disc is the same neutral translucent grey and ONLY the glyph carries
 *     colour — that uniformity is what makes the row look engineered rather
 *     than assembled.
 */
const DISC_LG = 56;
const DISC_SM = 50;
const GAP = 10;
/** Glyph-to-disc ratio, from the reference. */
const GLYPH = 0.47;

/**
 * Neutral translucent disc. Translucency (rather than a solid navy) means it
 * picks up the poster behind it exactly as the reference does over artwork,
 * and it stays legible over both bright and dark cards.
 */
const DISC_FILL = 'rgba(255,255,255,0.14)';

interface ActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  size: number;
  onPress: () => void;
  /** Optional secondary action; see the save-sheet note on DeckActions. */
  onLongPress?: () => void;
  accessibilityLabel: string;
}

function ActionButton({
  icon,
  color,
  size,
  onPress,
  onLongPress,
  accessibilityLabel,
}: ActionButtonProps) {
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      haptic="light"
      // A small circular target needs a bigger proportional squash than the
      // app default (0.95) for the press to register visually.
      activeScale={0.86}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: DISC_FILL,
        boxShadow: '0px 6px 16px rgba(0,0,0,0.45)',
        elevation: 6,
      }}
    >
      <Ionicons name={icon} size={Math.round(size * GLYPH)} color={color} />
    </PressableScale>
  );
}

export interface DeckActionsProps {
  onAction: (direction: SwipeDirection) => void;
  /**
   * Long-press on the watchlist button: opens the save sheet instead of
   * filing the title immediately.
   *
   * Deliberately a SECONDARY affordance. A tap must keep doing what it has
   * always done — file the card and move on — because that is the deck's whole
   * rhythm. Putting the sheet behind a long-press adds the choice without
   * taxing the fast path, and it lives out here on the button rather than on
   * the card itself, so the card's pan/tap gestures are untouched.
   */
  onLongPressSave?: () => void;
  labels: { like: string; nope: string; superlike: string; seen: string };
}

/**
 * Button equivalents of the four gestures: Pass, Seen, Watchlist, Like.
 *
 * Rendered in LOGICAL order inside a flex-row, so under RTL the row mirrors
 * and "Like" stays on the side the like-gesture physically exits toward.
 *
 * Glyphs are the set the product owner specified — red ✕, yellow eye, green
 * bookmark, green heart. NOTE for the record: the reference screenshots
 * actually use a red thumbs-DOWN and a green thumbs-UP, with two YELLOW
 * media-transport buttons (skip-back / skip-forward) in the middle rather
 * than an eye and a bookmark. Those transport actions have no equivalent in
 * this app, so the owner's glyph set is used while the reference's GEOMETRY
 * — sizes, ratio, gap, uniform disc — is matched exactly.
 */
export function DeckActions({ onAction, onLongPressSave, labels }: DeckActionsProps) {
  return (
    <View className="flex-row items-center justify-center" style={{ gap: GAP }}>
      <ActionButton
        icon="close"
        color={C.nope}
        size={DISC_LG}
        onPress={() => onAction('dislike')}
        accessibilityLabel={labels.nope}
      />
      <ActionButton
        icon="eye"
        color={C.seen}
        size={DISC_SM}
        onPress={() => onAction('seen')}
        accessibilityLabel={labels.seen}
      />
      <ActionButton
        icon="bookmark"
        color={C.super}
        size={DISC_SM}
        onPress={() => onAction('superlike')}
        onLongPress={onLongPressSave}
        accessibilityLabel={labels.superlike}
      />
      <ActionButton
        icon="heart"
        color={C.like}
        size={DISC_LG}
        onPress={() => onAction('like')}
        accessibilityLabel={labels.like}
      />
    </View>
  );
}
