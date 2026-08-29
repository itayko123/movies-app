/**
 * Guards around Expo native module calls.
 *
 * Expo modules validate arguments *synchronously* inside `expo-modules-core`
 * and throw a `CodedError` (e.g. "Received 1 arguments, but 0 was expected")
 * before they ever return a promise. That means `someAsyncApi(x).catch(...)`
 * does NOT protect you — the throw happens while evaluating the call, so the
 * rejection escapes as an unhandled promise rejection and Expo Go shows a red
 * screen.
 *
 * These helpers wrap the *invocation itself* in try/catch, so both synchronous
 * throws and rejected promises are contained. Every native call that is
 * optional to the app's function (haptics, splash, system chrome, prefetch)
 * goes through here.
 */

function report(label: string, error: unknown): void {
  if (__DEV__) {
    console.warn(`[safeNative] ${label} unavailable:`, error);
  }
}

/**
 * Runs a native call that may throw synchronously and/or reject.
 * Returns `null` instead of propagating — callers treat it as "unsupported".
 */
export async function safeAsync<T>(
  label: string,
  fn: () => Promise<T> | T,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    report(label, error);
    return null;
  }
}

/** Fire-and-forget variant: never returns a promise, never rejects. */
export function safeFireAndForget(label: string, fn: () => Promise<unknown> | unknown): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch((error) => report(label, error));
    }
  } catch (error) {
    report(label, error);
  }
}

/** Synchronous native call guard. */
export function safeSync<T>(label: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (error) {
    report(label, error);
    return null;
  }
}
