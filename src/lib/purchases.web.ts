import type { PurchasesPackage } from 'react-native-purchases';

/**
 * Web mock for RevenueCat. Type-only imports are erased at compile time, so
 * the native SDK never enters the web bundle. The paywall renders its
 * "purchases unavailable" state on web.
 */

export const PREMIUM_ENTITLEMENT = 'premium';

export function purchasesAvailable(): boolean {
  return false;
}

export async function configurePurchases(_userId: string): Promise<void> {
  // No-op on web.
}

export async function getPremiumPackages(): Promise<PurchasesPackage[]> {
  return [];
}

export async function purchasePremium(_pkg: PurchasesPackage): Promise<boolean> {
  throw new Error('purchases_unavailable_on_web');
}

export async function restorePurchases(): Promise<boolean> {
  return false;
}
