/**
 * Web mock for App Check. No Firebase import — attestation is a native
 * concern. Edge Functions with APP_CHECK_ENFORCED=true will reject web
 * callers; run the local stack with enforcement off when UI-testing the
 * AI flows in a browser.
 */
export async function getAppCheckToken(): Promise<string | null> {
  return null;
}
