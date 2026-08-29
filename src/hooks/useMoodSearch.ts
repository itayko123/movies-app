import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { invokeFunction, EdgeFunctionError } from '@/lib/functions';
import { llmAvailable } from '@/lib/llm';
import { resolveMoodWithLLM } from '@/lib/moodPlanner';
import { resolveMoodLocally } from '@/lib/moodResolver';
import { useAppStore } from '@/state/store';
import { useT, translate, type Translator } from '@/i18n';
import { MoodSearchResponseSchema, type MoodResult } from '@/types/media';
// TODO: MOCK AUTH - REMOVE BEFORE PRODUCTION
import { MOCK_AUTH_ENABLED } from '@/lib/devMock';

export interface MoodMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  results?: MoodResult[];
  isError?: boolean;
}

let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  return `msg-${messageCounter}`;
}

export interface UseMoodSearchResult {
  messages: MoodMessage[];
  isThinking: boolean;
  send: (query: string) => void;
  rateLimited: boolean;
}

interface Resolved {
  reply: string;
  results: MoodResult[];
}

/**
 * Runs a mood query through the AI Edge Function when it's reachable, and
 * falls back to the on-device resolver otherwise (web, Expo Go, mock auth, or
 * any backend failure) so the Concierge always returns real titles.
 */
async function runQuery(
  query: string,
  locale: 'en' | 'he',
  t: Translator,
): Promise<Resolved> {
  const local = async (): Promise<Resolved> => {
    const { results } = await resolveMoodLocally(query, locale);
    return {
      reply:
        results.length > 0
          ? translate(locale, 'mood.localReply', { query })
          : translate(locale, 'mood.noResults'),
      results,
    };
  };

  /**
   * AI first, whenever a model is reachable.
   *
   * This runs BEFORE the Edge Function and before the local resolver because
   * it is the only path that understands arbitrary phrasing. It returns null
   * — never throws — when unconfigured or unhelpful, so the chain below is
   * unaffected on a machine with no key.
   *
   * The model's own sentence is used as the reply when it produced one: it was
   * written in the user's language and describes what was actually searched
   * for, which is more informative than the generic template.
   */
  const ai = async (): Promise<Resolved | null> => {
    if (!llmAvailable()) return null;
    const resolved = await resolveMoodWithLLM(query, locale).catch(() => null);
    if (!resolved) return null;
    return {
      reply: resolved.plan.reply ?? translate(locale, 'mood.localReply', { query }),
      results: resolved.results,
    };
  };

  // TODO: MOCK AUTH - REMOVE BEFORE PRODUCTION — the function would 401.
  if (MOCK_AUTH_ENABLED) return (await ai()) ?? local();

  try {
    const raw = await invokeFunction<unknown>('mood-search', { query, locale });
    const parsed = MoodSearchResponseSchema.parse(raw);
    return { reply: parsed.reply, results: parsed.results };
  } catch (error) {
    // A genuine quota response must surface to the user, not be papered over.
    if (error instanceof EdgeFunctionError && error.isRateLimited) throw error;
    if (__DEV__) console.warn('mood-search unavailable, trying AI then local:', error);
    return (await ai()) ?? local();
  }
}

/** Chat-style state machine over the mood matcher. */
export function useMoodSearch(): UseMoodSearchResult {
  const t = useT();
  const locale = useAppStore((s) => s.locale);
  const [messages, setMessages] = useState<MoodMessage[]>([]);
  const [rateLimited, setRateLimited] = useState(false);

  const mutation = useMutation({
    mutationFn: (query: string) => runQuery(query, locale, t),
    onSuccess: (resolved) => {
      setRateLimited(false);
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          text: resolved.reply,
          results: resolved.results,
        },
      ]);
    },
    onError: (error) => {
      let text = t('common.error');
      if (error instanceof EdgeFunctionError && error.isRateLimited) {
        setRateLimited(true);
        const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 3600) / 60));
        text = t('mood.limitBody', { minutes });
      }
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', text, isError: true },
      ]);
    },
  });

  const send = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length < 2 || mutation.isPending) return;
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: trimmed }]);
      mutation.mutate(trimmed);
    },
    [mutation],
  );

  return { messages, isThinking: mutation.isPending, send, rateLimited };
}
