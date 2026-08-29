import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { MediaResultCard } from '@/components/MediaResultCard';
import { useT } from '@/i18n';
import type { MoodMessage } from '@/hooks/useMoodSearch';

/**
 * One chat message in the AI Concierge. User bubbles hug the logical END
 * side, assistant bubbles the START side — both mirror under RTL because
 * only logical alignment classes are used.
 */
export function MoodBubble({ message }: { message: MoodMessage }) {
  const t = useT();
  const router = useRouter();

  if (message.role === 'user') {
    return (
      <View className="items-end mb-3">
        <View className="bg-olive rounded-3xl rounded-ee-md px-4 py-3 max-w-[82%]">
          <AppText variant="bodyStrong" className="text-txt">
            {message.text}
          </AppText>
        </View>
      </View>
    );
  }

  return (
    <View className="items-start mb-3">
      <GlassView
        className={`rounded-3xl rounded-es-md px-4 py-3 max-w-[92%] ${
          message.isError ? 'border-nope/50' : ''
        }`}
      >
        <AppText variant="body" className={message.isError ? 'text-nope' : 'text-txt'}>
          {message.text}
        </AppText>
      </GlassView>

      {message.results && message.results.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="mt-3"
          contentContainerStyle={{ gap: 12, paddingHorizontal: 2 }}
        >
          {message.results.map((result) => (
            <MediaResultCard
              key={result.id}
              result={result}
              matchLabel={t('mood.match', {
                percent: Math.round(result.similarity * 100),
              })}
              onPress={() =>
                router.push({
                  pathname: '/media/[id]',
                  params: {
                    id: String(result.tmdb_id),
                    type: result.media_type,
                    mediaItemId: result.id,
                    title: result.title,
                    poster: result.poster_path ?? '',
                  },
                })
              }
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
