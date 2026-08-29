import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useEffect } from 'react';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { REGIONS, type RegionCode } from '@/lib/tmdb';
import { useAppStore } from '@/state/store';

const SELECT_SPRING = { damping: 13, stiffness: 340, mass: 0.6 } as const;

function RegionChip({
  code,
  flag,
  label,
  active,
  onPress,
}: {
  code: RegionCode;
  flag: string;
  label: string;
  active: boolean;
  onPress: (code: RegionCode) => void;
}) {
  const chosen = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    chosen.value = withSpring(active ? 1 : 0, SELECT_SPRING);
  }, [active, chosen]);

  // Selected chip lifts slightly — persists after the finger leaves, so it
  // cannot be expressed by press state alone.
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.04 * chosen.value }],
  }));

  return (
    <PressableScale
      onPress={() => onPress(code)}
      haptic="medium"
      activeScale={0.9}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      <Animated.View
        style={[
          liftStyle,
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            borderRadius: 999,
            paddingHorizontal: 13,
            paddingVertical: 7,
            backgroundColor: active ? 'rgba(0,184,217,0.16)' : 'rgba(255,255,255,0.05)',
            ...(active ? { boxShadow: '0px 4px 14px rgba(0,184,217,0.28)' } : null),
          },
        ]}
      >
        <AppText variant="caption" style={{ fontSize: 14 }}>
          {flag}
        </AppText>
        <AppText
          variant="caption"
          className={active ? 'text-brand' : 'text-txt-secondary'}
        >
          {label}
        </AppText>
      </Animated.View>
    </PressableScale>
  );
}

/**
 * Content-origin chips.
 *
 * Origin is the broadest cut of the catalogue and the one users are most
 * deliberate about ("show me Korean things"), so it leads the filter rail. It
 * is also the only filter the app will never silently relax — see
 * resolveDeckQuery.
 *
 * Returned WITHOUT a scroll container: these share one horizontal rail with the
 * genre pills in DeckFilterBar. They used to own a scroll row of their own,
 * which cost the deck a whole extra line of vertical space.
 */
export function RegionChips() {
  const region = useAppStore((s) => s.region);
  const setRegion = useAppStore((s) => s.setRegion);

  return (
    <>
      {REGIONS.map((entry) => (
        <RegionChip
          key={entry.code}
          code={entry.code}
          flag={entry.flag}
          label={entry.label}
          active={region === entry.code}
          onPress={setRegion}
        />
      ))}
    </>
  );
}
