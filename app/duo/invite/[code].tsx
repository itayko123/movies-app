import { useEffect } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityIndicator } from 'react-native';

import { AppText } from '@/components/AppText';
import { useAppStore } from '@/state/store';
import { useT } from '@/i18n';
import { C, SPACE } from '@/theme/tokens';

/**
 * Duo invite deep link: `https://cineswipe.app/duo/invite/<ROOM CODE>`.
 *
 * ── What this route used to be, and why it could never have worked ─────────
 * It was `[sessionId].tsx` and drove `useDuoSession`, a hook written against
 * the ABANDONED v1 schema: it called `rpc('join_duo_session', { p_session_id })`
 * against a `duo_sessions` table. Neither the function nor the table exists in
 * the live database — the live design is `duo_rooms` joined by a six-character
 * `room_code` via `join_duo_room(p_room_code)`.
 *
 * So this path failed twice over. The RPC 404'd, and even if it had existed it
 * was being handed the wrong KIND of identifier: `duo.tsx` builds the invite
 * URL from `room.code` (six chars), while the route named the segment
 * `sessionId` and the hook treated it as a UUID. A rename alone would not have
 * fixed it.
 *
 * ── What it is now ─────────────────────────────────────────────────────────
 * A redirect, not a second Duo screen. The Duo TAB already owns the working
 * implementation (`useDuoRoom`, which speaks to the live schema), including
 * the deck, the vote exchange and the match overlay. Standing up a parallel
 * duo surface here would mean two copies of that logic drifting apart — which
 * is exactly the situation this phase exists to clean up. The code is handed
 * to the tab as a param and the tab performs the join.
 */
export default function DuoInviteScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { code } = useLocalSearchParams<{ code?: string }>();
  const session = useAppStore((s) => s.session);

  useEffect(() => {
    if (!code) return;
    // Wait for auth: the tab cannot join a room as nobody, and the routing
    // gate would bounce an anonymous visitor to /auth anyway. Once signed in
    // this effect re-runs and the redirect proceeds.
    if (!session) return;

    router.replace({
      pathname: '/duo',
      params: { joinCode: code.toUpperCase() },
    });
  }, [code, session, router]);

  return (
    <View
      className="flex-1 items-center justify-center"
      style={{ backgroundColor: C.bg, paddingTop: insets.top, gap: SPACE.lg }}
    >
      <ActivityIndicator color={C.accent} />
      <AppText variant="body">{t('duo.joining')}</AppText>
    </View>
  );
}
