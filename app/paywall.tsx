import { useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { PurchasesPackage } from 'react-native-purchases';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { Skeleton } from '@/components/Skeleton';
import {
  getPremiumPackages,
  purchasePremium,
  purchasesAvailable,
  restorePurchases,
} from '@/lib/purchases';
import { hapticSelection, hapticSuccess, hapticWarning } from '@/lib/haptics';
import { useT, type TranslationKey } from '@/i18n';
import { C } from '@/theme/tokens';

const FEATURES: Array<{ icon: string; key: TranslationKey }> = [
  { icon: 'infinite', key: 'paywall.featureSwipes' },
  { icon: 'sparkles', key: 'paywall.featureAI' },
  { icon: 'people', key: 'paywall.featureDuo' },
  { icon: 'stats-chart', key: 'paywall.featureStats' },
  { icon: 'eye-off', key: 'paywall.featureAdFree' },
];

export default function PaywallScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [packages, setPackages] = useState<PurchasesPackage[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!purchasesAvailable()) {
      setPackages([]);
      return;
    }
    getPremiumPackages()
      .then(setPackages)
      .catch(() => setPackages([]));
  }, []);

  const buy = async (pkg: PurchasesPackage) => {
    if (busy) return;
    setBusy(true);
    hapticSelection();
    try {
      const premium = await purchasePremium(pkg);
      if (premium) {
        hapticSuccess();
        Alert.alert(t('paywall.success'));
        router.back();
      }
    } catch (err) {
      // User cancellation is not an error state worth alerting about.
      const cancelled =
        typeof err === 'object' && err !== null && 'userCancelled' in err
          ? Boolean((err as { userCancelled?: boolean }).userCancelled)
          : false;
      if (!cancelled) {
        hapticWarning();
        Alert.alert(t('paywall.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    hapticSelection();
    try {
      const premium = await restorePurchases();
      if (premium) {
        hapticSuccess();
        router.back();
      }
    } catch {
      hapticWarning();
      Alert.alert(t('common.error'));
    }
  };

  return (
    <View className="flex-1 bg-app">
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 16,
          paddingHorizontal: 24,
          paddingBottom: insets.bottom + 32,
          gap: 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-1">
            <AppText variant="hero" className="text-brand">
              {t('paywall.title')}
            </AppText>
            <AppText variant="body" className="mt-1">
              {t('paywall.subtitle')}
            </AppText>
          </View>
          <PressableScale
            onPress={() => router.back()}
            haptic="light"
            activeScale={0.88}
            accessibilityRole="button"
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: 'rgba(255,255,255,0.08)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="close" size={20} color="#FAFAFA" />
          </PressableScale>
        </View>

        <GlassView className="rounded-sheet p-6 gap-4">
          {FEATURES.map((feature) => (
            <View key={feature.key} className="flex-row items-center gap-3">
              <View className="w-9 h-9 rounded-full bg-brand-soft items-center justify-center">
                <Ionicons
                  name={feature.icon as keyof typeof Ionicons.glyphMap}
                  size={17}
                  color="#00B8D9"
                />
              </View>
              <AppText variant="bodyStrong" className="flex-1">
                {t(feature.key)}
              </AppText>
            </View>
          ))}
        </GlassView>

        {packages == null ? (
          <View className="gap-3">
            <Skeleton className="h-16 rounded-2xl" />
            <Skeleton className="h-16 rounded-2xl" delay={90} />
          </View>
        ) : packages.length === 0 ? (
          <GlassView className="rounded-2xl p-5 items-center">
            <AppText variant="body" className="text-center">
              {t('paywall.unavailable')}
            </AppText>
          </GlassView>
        ) : (
          <View className="gap-3">
            {packages.map((pkg) => (
              <PressableScale
                key={pkg.identifier}
                onPress={() => void buy(pkg)}
                disabled={busy}
                haptic="medium"
                accessibilityRole="button"
                style={{
                  backgroundColor: '#00B8D9',
                  borderRadius: 16,
                  paddingHorizontal: 24,
                  paddingVertical: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <AppText variant="bodyStrong" className="flex-1" style={{ color: C.onAccent }}>
                  {pkg.product.title || pkg.identifier}
                </AppText>
                <AppText variant="subtitle" style={{ color: C.onAccent }}>
                  {pkg.product.priceString}
                </AppText>
              </PressableScale>
            ))}
            <PressableScale
              onPress={() => void restore()}
              haptic="light"
              accessibilityRole="button"
              style={{ paddingVertical: 12, alignItems: 'center' }}
            >
              <AppText variant="body" className="underline">
                {t('paywall.restore')}
              </AppText>
            </PressableScale>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
