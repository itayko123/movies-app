import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { levelNameKey, levelProgress, MAX_LEVEL } from '@/lib/quests';
import { useAppStore } from '@/state/store';
import { useT, type TranslationKey } from '@/i18n';

/**
 * Cinephile level badge.
 *
 * Two shapes from one component: a compact chip for the Discover header, and a
 * full card with an XP bar for Profile. Splitting them into separate components
 * would mean two places to keep the level colour ramp in step.
 *
 * The tier colour is derived from the level rather than stored, so adding a
 * level never requires touching a lookup table.
 */
function tierColor(level: number): string {
  if (level >= 10) return '#FBBF24'; // legend — gold
  if (level >= 7) return '#A78BFA'; // violet
  if (level >= 4) return '#00B8D9'; // brand
  return '#A78BFA'; // early levels — cool blue
}

export function LevelBadge({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const xp = useAppStore((s) => s.xp);
  const progress = levelProgress(xp);
  const color = tierColor(progress.level);
  const name = t(levelNameKey(progress.level) as TranslationKey);

  if (compact) {
    return (
      <View
        accessibilityRole="text"
        accessibilityLabel={`${t('level.short', { level: progress.level })} — ${name}`}
        className="flex-row items-center gap-1 rounded-full px-2.5 py-1"
        // Fill, no stroke. The system separates with surface contrast, not a
        // border, so the tint is raised from 22 to 2E to carry the weight the
        // 1pt outline used to. Glyph and label already run at full strength.
        style={{ backgroundColor: `${color}2E` }}
      >
        <Ionicons name="ribbon" size={12} color={color} />
        <AppText variant="caption" style={{ color }}>
          {t('level.short', { level: progress.level })}
        </AppText>
      </View>
    );
  }

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <View
          className="items-center justify-center rounded-2xl"
          style={{
            width: 44,
            height: 44,
            backgroundColor: `${color}22`,
          }}
        >
          <Ionicons name="ribbon" size={22} color={color} />
        </View>

        <View className="flex-1">
          <AppText variant="bodyStrong" style={{ color }}>
            {name}
          </AppText>
          <AppText variant="caption" className="text-txt-secondary">
            {progress.level >= MAX_LEVEL
              ? t('level.max')
              : t('level.toNext', {
                  remaining: progress.remaining ?? 0,
                  next: progress.level + 1,
                })}
          </AppText>
        </View>

        <AppText variant="caption" className="text-txt-secondary">
          {t('level.short', { level: progress.level })}
        </AppText>
      </View>

      {/* Track is always full-width; only the fill is proportional, so a
          level-1 user still sees where the bar ends rather than a stub. */}
      <View className="h-2 rounded-full overflow-hidden bg-white/10">
        <View
          style={{
            width: `${Math.round(progress.ratio * 100)}%`,
            height: '100%',
            backgroundColor: color,
            borderRadius: 999,
          }}
        />
      </View>
    </View>
  );
}
