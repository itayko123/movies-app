import { useEffect } from 'react';
import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { QUEST_XP, type DailyQuest, type QuestKind } from '@/lib/quests';
import { useAppStore } from '@/state/store';
import { useT, type TranslationKey } from '@/i18n';

const ICONS: Record<QuestKind, keyof typeof Ionicons.glyphMap> = {
  swipe: 'albums-outline',
  watchlist: 'bookmark-outline',
  review: 'create-outline',
  high_rating: 'star-outline',
  region: 'flag-outline',
  duo: 'people-outline',
  mood: 'sparkles-outline',
};

function QuestRow({ quest }: { quest: DailyQuest }) {
  const t = useT();
  const ratio = Math.min(quest.progress / quest.goal, 1);
  const color = quest.completed ? '#00B8D9' : '#00B8D9';

  return (
    <View className="flex-row items-center gap-3">
      <View
        className="items-center justify-center rounded-xl"
        style={{
          width: 34,
          height: 34,
          backgroundColor: quest.completed ? 'rgba(34,197,94,0.16)' : 'rgba(255,255,255,0.06)',
        }}
      >
        <Ionicons
          name={quest.completed ? 'checkmark-circle' : ICONS[quest.type]}
          size={18}
          color={quest.completed ? '#00B8D9' : '#94A3B8'}
        />
      </View>

      <View className="flex-1 gap-1.5">
        <View className="flex-row items-center justify-between gap-2">
          <AppText
            variant="caption"
            numberOfLines={1}
            className={quest.completed ? 'flex-1 text-txt-secondary' : 'flex-1 text-txt'}
          >
            {t(`quests.${quest.type}` as TranslationKey, { goal: quest.goal })}
          </AppText>
          <AppText variant="caption" style={{ color }}>
            {quest.completed ? t('quests.reward', { xp: QUEST_XP }) : `${quest.progress}/${quest.goal}`}
          </AppText>
        </View>

        <View className="h-1.5 rounded-full overflow-hidden bg-white/10">
          <View
            style={{
              width: `${Math.round(ratio * 100)}%`,
              height: '100%',
              backgroundColor: color,
              borderRadius: 999,
            }}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * The day's three quests.
 *
 * Calls `ensureQuests` on mount so the set rolls over when the app has been
 * open across midnight — the quests are derived from the date, but nothing
 * recomputes them on its own while the process stays alive.
 */
export function QuestPanel() {
  const t = useT();
  const quests = useAppStore((s) => s.quests);
  const ensureQuests = useAppStore((s) => s.ensureQuests);

  useEffect(() => {
    ensureQuests();
  }, [ensureQuests]);

  if (quests.length === 0) return null;

  const done = quests.filter((q) => q.completed).length;
  const allDone = done === quests.length;

  return (
    <GlassView className="rounded-sheet p-4 gap-3">
      <View className="flex-row items-center gap-2">
        <Ionicons name="flash" size={16} color="#FBBF24" />
        <AppText variant="bodyStrong" className="flex-1">
          {t('quests.title')}
        </AppText>
        <AppText variant="caption" className="text-txt-secondary">
          {allDone ? t('quests.allDone') : t('quests.subtitle', { done, total: quests.length })}
        </AppText>
      </View>

      <View className="gap-3">
        {quests.map((quest) => (
          <QuestRow key={quest.type} quest={quest} />
        ))}
      </View>
    </GlassView>
  );
}
