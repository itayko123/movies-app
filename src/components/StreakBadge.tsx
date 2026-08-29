import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { useT } from '@/i18n';
import { useAppStore } from '@/state/store';

/**
 * Compact streak indicator for the Discover header.
 *
 * Hidden entirely at zero rather than showing "0 days". A zero-streak badge is
 * a nag, and it takes header space away from the region switcher for the sake
 * of telling the user they have not done anything yet.
 */
export function StreakBadge() {
  const t = useT();
  const streak = useAppStore((s) => s.streak);
  if (streak.current < 1) return null;

  // Warmer as the streak grows — a small, wordless reward for coming back.
  const hot = streak.current >= 7;

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={t('streak.day', { count: streak.current })}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: hot ? 'rgba(0,184,217,0.16)' : 'rgba(255,255,255,0.07)',
      }}
    >
      <Ionicons name="flame" size={13} color={hot ? '#00B8D9' : '#FBBF24'} />
      <AppText variant="caption" className={hot ? 'text-brand' : 'text-txt'}>
        {streak.current}
      </AppText>
    </View>
  );
}
