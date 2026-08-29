import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  I18nManager,
  Keyboard,
  Pressable,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { useT } from '@/i18n';
import { useAppStore } from '@/state/store';
import { imageUrl, searchByScope, type MediaDraft, type SearchScope } from '@/lib/tmdb';
import { C, R, SPACE } from '@/theme/tokens';

/**
 * Text search across the TMDB catalogue, with an Israeli / International scope.
 *
 * ── Why a scope toggle at all ──────────────────────────────────────────────
 * This is a Hebrew-first app whose audience searches for both — "Fauda" and
 * "Dune" in the same session. A single blended list buries the Israeli hit:
 * TMDB ranks by global popularity, so a domestic title with a few hundred
 * votes loses to any international release every time. The toggle is what
 * makes the domestic catalogue reachable, not a cosmetic filter.
 *
 * The scope filter runs over search RESULTS rather than in the query, because
 * TMDB's search endpoints accept no language or country parameter — see
 * `searchByScope` for why, and for why it pages while filtering.
 */

const SCOPES = [
  { key: 'all', label: 'search.scopeAll', icon: 'apps-outline' },
  { key: 'israeli', label: 'search.scopeIsraeli', icon: 'flag-outline' },
  { key: 'international', label: 'search.scopeInternational', icon: 'globe-outline' },
] as const;

/** Mirrors an icon under RTL so directional glyphs point the right way. */
function rtlFlip() {
  return I18nManager.isRTL ? [{ scaleX: -1 as const }] : undefined;
}

export default function SearchScreen() {
  const t = useT();
  const locale = useAppStore((s) => s.locale);
  const { width } = useWindowDimensions();

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [results, setResults] = useState<MediaDraft[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Guards against a slow early request landing after a faster later one and
  // overwriting fresher results — the classic search race.
  const requestId = useRef(0);

  const columns = width >= 700 ? 4 : 3;
  const gutter = SPACE.md;
  const edge = SPACE.edge;
  const cellWidth = Math.floor((width - edge * 2 - gutter * (columns - 1)) / columns);

  const run = useCallback(
    async (text: string, nextScope: SearchScope) => {
      const trimmed = text.trim();
      if (trimmed.length < 2) {
        setResults(null);
        setLoading(false);
        return;
      }
      const id = ++requestId.current;
      setLoading(true);
      const found = await searchByScope(trimmed, locale, nextScope).catch(() => []);
      if (id !== requestId.current) return; // A newer search already won.
      setResults(found);
      setLoading(false);
    },
    [locale],
  );

  const onSubmit = useCallback(() => {
    Keyboard.dismiss();
    void run(query, scope);
  }, [query, scope, run]);

  const onScope = useCallback(
    (next: SearchScope) => {
      setScope(next);
      // Re-run immediately: changing scope with results on screen and nothing
      // happening reads as a broken control.
      if (query.trim().length >= 2) void run(query, next);
    },
    [query, run],
  );

  const empty = useMemo(() => {
    if (loading || results === null) return null;
    if (results.length > 0) return null;
    return (
      <View style={{ alignItems: 'center', paddingTop: SPACE.xxl * 2, gap: SPACE.md }}>
        <Ionicons name="search-outline" size={40} color={C.textTertiary} />
        <AppText variant="bodyStrong" className="text-center">
          {t('search.emptyTitle')}
        </AppText>
        <AppText
          variant="caption"
          className="text-center"
          style={{ color: C.textSecondary, paddingHorizontal: SPACE.xxl }}
        >
          {scope === 'israeli' ? t('search.emptyIsraeli') : t('search.emptyBody')}
        </AppText>
      </View>
    );
  }, [loading, results, scope, t]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* ── Search bar ─────────────────────────────────────────────────── */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: SPACE.md,
          paddingHorizontal: SPACE.edge,
          paddingTop: SPACE.md,
          paddingBottom: SPACE.sm,
        }}
      >
        <PressableScale
          onPress={() => router.back()}
          haptic="light"
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          style={{ padding: SPACE.xs }}
        >
          <Ionicons
            name="chevron-back"
            size={26}
            color={C.text}
            style={{ transform: rtlFlip() }}
          />
        </PressableScale>

        <GlassView
          className="flex-1 flex-row items-center"
          style={{ borderRadius: R.pill, paddingHorizontal: SPACE.lg, gap: SPACE.sm }}
        >
          <Ionicons name="search" size={18} color={C.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={onSubmit}
            returnKeyType="search"
            autoFocus
            placeholder={t('search.placeholder')}
            placeholderTextColor={C.textTertiary}
            // The app is Hebrew-first but the catalogue is bilingual, so the
            // field must not force a direction — `auto` follows what is typed.
            textAlign={I18nManager.isRTL ? 'right' : 'left'}
            style={{
              flex: 1,
              color: C.text,
              paddingVertical: SPACE.md,
              fontSize: 16,
              writingDirection: 'auto',
            }}
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => {
                setQuery('');
                setResults(null);
              }}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('search.clear')}
            >
              <Ionicons name="close-circle" size={18} color={C.textTertiary} />
            </Pressable>
          )}
        </GlassView>
      </View>

      {/* ── Scope toggle ───────────────────────────────────────────────── */}
      <View
        style={{
          flexDirection: 'row',
          gap: SPACE.sm,
          paddingHorizontal: SPACE.edge,
          paddingBottom: SPACE.md,
        }}
      >
        {SCOPES.map((option) => {
          const active = option.key === scope;
          return (
            <PressableScale
              key={option.key}
              onPress={() => onScope(option.key)}
              haptic="light"
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: SPACE.xs,
                borderRadius: R.pill,
                paddingHorizontal: SPACE.lg,
                paddingVertical: SPACE.sm,
                backgroundColor: active ? C.accentSoft : C.surface,
              }}
            >
              <Ionicons
                name={option.icon}
                size={14}
                color={active ? C.accent : C.textTertiary}
              />
              <AppText
                variant="caption"
                style={{ color: active ? C.accent : C.textSecondary }}
              >
                {t(option.label)}
              </AppText>
            </PressableScale>
          );
        })}
      </View>

      {loading && (
        <View style={{ paddingTop: SPACE.xxl }}>
          <ActivityIndicator color={C.accent} />
        </View>
      )}

      {!loading && results === null && (
        <View style={{ alignItems: 'center', paddingTop: SPACE.xxl * 2, gap: SPACE.md }}>
          <Ionicons name="film-outline" size={40} color={C.textTertiary} />
          <AppText variant="caption" style={{ color: C.textSecondary }}>
            {t('search.prompt')}
          </AppText>
        </View>
      )}

      {empty}

      {!loading && results !== null && results.length > 0 && (
        <FlatList
          data={results}
          keyExtractor={(item) => `${item.media_type}:${item.tmdb_id}`}
          numColumns={columns}
          // Remounting on column change is required — FlatList cannot change
          // numColumns on the fly.
          key={`cols-${columns}`}
          contentContainerStyle={{
            paddingHorizontal: SPACE.edge,
            paddingBottom: SPACE.xxl,
            gap: gutter,
          }}
          columnWrapperStyle={{ gap: gutter }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <PressableScale
              onPress={() => router.push(`/media/${item.tmdb_id}?type=${item.media_type}`)}
              haptic="light"
              accessibilityRole="button"
              accessibilityLabel={item.title}
              style={{ width: cellWidth }}
            >
              <Image
                source={{ uri: imageUrl(item.poster_path, 'w342') ?? undefined }}
                style={{
                  width: cellWidth,
                  height: Math.round(cellWidth * 1.5),
                  borderRadius: R.card,
                  backgroundColor: C.surface,
                }}
                contentFit="cover"
                transition={160}
              />
              <AppText
                variant="caption"
                numberOfLines={2}
                style={{ marginTop: SPACE.xs, color: C.textSecondary }}
              >
                {item.title}
              </AppText>
            </PressableScale>
          )}
        />
      )}
    </SafeAreaView>
  );
}
