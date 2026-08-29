import { Platform } from 'react-native';
import type { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import { env } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { IS_EXPO_GO } from '@/lib/runtime';
import { useAppStore } from '@/state/store';

/**
 * RevenueCat — native builds only. Runtime values from
 * `react-native-purchases` are lazy-required (type-only imports above are
 * erased at compile time), so this module is import-safe in Expo Go, where
 * `purchasesAvailable()` simply reports false.
 */


export const PREMIUM_ENTITLEMENT = 'premium';

type PurchasesModule = typeof import('react-native-purchases').default;

function getPurchases(): PurchasesModule {
  return require('react-native-purchases').default;
}

function apiKey(): string {
  return Platform.OS === 'ios'
    ? env.EXPO_PUBLIC_REVENUECAT_APPLE_KEY
    : env.EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY;
}

export function purchasesAvailable(): boolean {
  return apiKey().length > 0 && !IS_EXPO_GO;
}

function customerIsPremium(info: CustomerInfo): boolean {
  return info.entitlements.active[PREMIUM_ENTITLEMENT] != null;
}

/**
 * Applies a fresh CustomerInfo everywhere it matters:
 * - Zustand entitlement slice → persisted to ENCRYPTED MMKV. This is the
 *   offline source of truth: a paying user who opens the app without network
 *   still gets an ad-free experience from the cached, tamper-resistant flag.
 * - profiles.is_premium → lets Edge Functions skip rate limits. In production
 *   the RevenueCat → Supabase webhook is authoritative; this client write is
 *   an optimistic fast-path.
 */
async function applyCustomerInfo(info: CustomerInfo): Promise<void> {
  const premium = customerIsPremium(info);
  useAppStore.getState().setPremium(premium);

  const userId = useAppStore.getState().session?.user.id;
  if (userId) {
    await supabase
      .from('profiles')
      .update({ is_premium: premium })
      .eq('id', userId);
  }
}

let configuredFor: string | null = null;

export async function configurePurchases(userId: string): Promise<void> {
  if (!purchasesAvailable() || configuredFor === userId) return;

  const Purchases = getPurchases();
  const { LOG_LEVEL } = require('react-native-purchases');

  Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.ERROR);
  Purchases.configure({ apiKey: apiKey(), appUserID: userId });
  configuredFor = userId;

  Purchases.addCustomerInfoUpdateListener((info: CustomerInfo) => {
    void applyCustomerInfo(info);
  });

  try {
    const info = await Purchases.getCustomerInfo();
    await applyCustomerInfo(info);
  } catch {
    // Offline launch: the encrypted MMKV cache (entitlement slice) governs.
  }
}

export async function getPremiumPackages(): Promise<PurchasesPackage[]> {
  if (!purchasesAvailable()) return [];
  const offerings = await getPurchases().getOfferings();
  return offerings.current?.availablePackages ?? [];
}

export async function purchasePremium(pkg: PurchasesPackage): Promise<boolean> {
  const { customerInfo } = await getPurchases().purchasePackage(pkg);
  await applyCustomerInfo(customerInfo);
  return customerIsPremium(customerInfo);
}

export async function restorePurchases(): Promise<boolean> {
  if (!purchasesAvailable()) return false;
  const info = await getPurchases().restorePurchases();
  await applyCustomerInfo(info);
  return customerIsPremium(info);
}
