import { useCallback, useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { fetchPopularPeople, imageUrl } from '@/lib/tmdb';
import { selectTopCredits, useAppStore, type PersonRole } from '@/state/store';
import { useT } from '@/i18n';
import { C, SPACE } from '@/theme/tokens';

/**
 * The "Cineheads" row: circular portraits of the people behind what you watch.
 *
 * ── Real data, not a fake social graph ─────────────────────────────────────
 * The reference fills this row with users to follow and their follower counts.
 * We have no follow graph, and inventing follower numbers in a commercial app
 * is not something to ship. So the row keeps the reference's exact geometry and
 * carries the people the taste engine has actually learned — the actors and
 * directors whose titles you swiped right on — with `PersonAffinity.count`,
 * a real distinct-title counter tracked at learn time, where the reference
 * shows followers.
 *
 * ── Cold start ─────────────────────────────────────────────────────────────
 * A new account has an empty person vector. Hiding the row there would leave
 * the most important first impression looking half-built, so it falls back to
 * TMDB's globally popular people. The sub-line changes with it — "3 titles you
 * liked" is a claim about you and is only ever shown when it is true; the
 * fallback says "Popular now" instead. Populated always, dishonest never.
 *
 * ── No borders ─────────────────────────────────────────────────────────────
 * The reference ring around each portrait is drawn as a filled disc with the
 * portrait inset on top, not as a border. That is not a workaround — the design
 * system bans border tokens outright (see tokens.ts), and a filled ring renders
 * identically while staying inside the rule.
 */

const AVATAR = 76;
const RING = 3;
const PORTRAIT = AVATAR - RING * 2;
const COLUMN = 92;

export interface CineheadsRowProps {
  onOpen: (person: { id: number; name: string; role: PersonRole }) => void;
}

interface Face {
  id: number;
  name: string;
  role: PersonRole;
  profilePath: string | null;
  /** Distinct swiped titles this credit appeared on; 0 for fallback people. */
  count: number;
}

export function CineheadsRow({ onOpen }: CineheadsRowProps) {
  const t = useT();
  const locale = useAppStore((s) => s.locale);
  const personWeights = useAppStore((s) => s.personWeights);

  const learned = useMemo<Face[]>(
    () =>
      selectTopCredits(personWeights, 8).map((person) => ({
        id: person.id,
        name: person.name,
        role: person.role,
        profilePath: person.profile_path,
        count: person.count,
      })),
    [personWeights],
  );

  /**
   * Only fetched when there is nothing learned yet, and it fails silently: a
   * decorative row must never surface a TMDB error on the main screen.
   */
  const fallback = useQuery({
    queryKey: ['popular-people', locale],
    queryFn: () => fetchPopularPeople(locale).catch(() => []),
    enabled: learned.length === 0,
    staleTime: 12 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });

  const faces: Face[] =
    learned.length > 0
      ? learned
      : (fallback.data ?? []).map((person) => ({
          id: person.id,
          name: person.name,
          role: person.department === 'Directing' ? ('director' as const) : ('cast' as const),
          profilePath: person.profile_path,
          count: 0,
        }));

  if (faces.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: SPACE.edge, gap: SPACE.md }}
      directionalLockEnabled
    >
      {faces.map((face) => (
        <FaceTile key={`${face.role}-${face.id}`} face={face} onOpen={onOpen} t={t} />
      ))}
    </ScrollView>
  );
}

function FaceTile({
  face,
  onOpen,
  t,
}: {
  face: Face;
  onOpen: CineheadsRowProps['onOpen'];
  t: ReturnType<typeof useT>;
}) {
  const portrait = imageUrl(face.profilePath, 'w185');

  const open = useCallback(
    () => onOpen({ id: face.id, name: face.name, role: face.role }),
    [face, onOpen],
  );

  return (
    <PressableScale
      onPress={open}
      haptic="light"
      activeScale={0.94}
      accessibilityRole="button"
      accessibilityLabel={face.name}
      style={{ width: COLUMN, alignItems: 'center', gap: 7 }}
    >
      <View>
        {/* The ring: a filled accent disc with the portrait inset on top. */}
        <View
          style={{
            width: AVATAR,
            height: AVATAR,
            borderRadius: AVATAR / 2,
            backgroundColor: C.accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {portrait ? (
            <Image
              source={{ uri: portrait }}
              style={{ width: PORTRAIT, height: PORTRAIT, borderRadius: PORTRAIT / 2 }}
              contentFit="cover"
              transition={220}
              cachePolicy="memory-disk"
              recyclingKey={face.profilePath ?? undefined}
            />
          ) : (
            /* Designed initial, never a blank circle — same rule as the
               poster wall's gradient tiles. */
            <View
              style={{
                width: PORTRAIT,
                height: PORTRAIT,
                borderRadius: PORTRAIT / 2,
                backgroundColor: C.surfaceRaised,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <AppText variant="subtitle" className="text-txt">
                {face.name.trim().charAt(0)}
              </AppText>
            </View>
          )}
        </View>

        {/* Role chip, where the reference puts its verified tick. */}
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            end: 0,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: C.accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={face.role === 'director' ? 'videocam' : 'person'}
            size={11}
            color={C.onAccent}
          />
        </View>
      </View>

      <AppText variant="bodyStrong" numberOfLines={1} style={{ width: COLUMN, textAlign: 'center' }}>
        {face.name}
      </AppText>

      <AppText variant="caption" numberOfLines={1} style={{ width: COLUMN, textAlign: 'center' }}>
        {face.count > 0
          ? t('discover.titlesYouLiked', { count: face.count })
          : t('discover.popularNow')}
      </AppText>
    </PressableScale>
  );
}
