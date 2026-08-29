import { I18nManager, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { C } from '@/theme/tokens';

export interface SectionHeaderProps {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  /** Optional trailing action, e.g. "View All". */
  action?: string;
  onAction?: () => void;
}

/**
 * Reference section header: circular dark icon chip, bold title, optional
 * lime "View All →" at the logical end. The arrow glyph is mirrored by hand
 * under RTL — Ionicons does not flip direction-carrying glyphs on its own.
 */
export function SectionHeader({ icon, title, action, onAction }: SectionHeaderProps) {
  return (
    <View className="flex-row items-center gap-3">
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: C.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={18} color={C.text} />
      </View>
      <AppText variant="title" className="flex-1" numberOfLines={1}>
        {title}
      </AppText>
      {action != null && onAction != null && (
        <PressableScale
          onPress={onAction}
          haptic="light"
          accessibilityRole="button"
          accessibilityLabel={action}
        >
          <View className="flex-row items-center gap-1.5">
            {/*
              `style`, not `className="text-brand"`. Every AppText variant
              already ends in a text-colour class, and NativeWind resolves that
              conflict by CSS emission order rather than by the order classes
              appear in the string — so `text-brand` silently lost and the
              label fell back to white. Latent until now only because no caller
              had ever passed an `action`; Phase 5 is the first.
            */}
            <AppText variant="bodyStrong" style={{ color: C.accent }}>
              {action}
            </AppText>
            <Ionicons
              name="arrow-forward"
              size={15}
              color={C.accent}
              style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
            />
          </View>
        </PressableScale>
      )}
    </View>
  );
}
