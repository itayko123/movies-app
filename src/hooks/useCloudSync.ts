import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { flush, pullRemote, setCloudSession, cloudReady } from '@/lib/cloudSync';
import { useAppStore } from '@/state/store';

/**
 * Keeps the cloud layer in step with the session, and drains the write queue.
 *
 * Mounted once, at the root. Three jobs:
 *
 *  1. Hand the session to cloudSync — which cannot read the store itself
 *     without closing an import cycle, so the push has to happen from here.
 *  2. Pull the user's rows ONCE per sign-in, so a new device or a reinstall
 *     arrives with their watchlist and progress rather than an empty app.
 *  3. Flush the queue when the app comes back to the foreground, which is both
 *     the moment connectivity is most likely to have returned and the moment
 *     the user is least likely to notice the work.
 */
export function useCloudSync(): void {
  const session = useAppStore((s) => s.session);
  const applyRemoteSnapshot = useAppStore((s) => s.applyRemoteSnapshot);

  // Which user id has already been pulled. Guards against re-pulling on every
  // token refresh, which replaces the session object without changing who is
  // signed in.
  const pulledFor = useRef<string | null>(null);

  useEffect(() => {
    setCloudSession(session);
  }, [session]);

  useEffect(() => {
    if (!cloudReady()) return;
    const userId = session?.user.id ?? null;
    if (!userId || pulledFor.current === userId) return;
    pulledFor.current = userId;

    void (async () => {
      // Local writes go up FIRST. Pulling first would compare the server
      // against a device whose newest changes it has not seen yet.
      await flush();
      const snapshot = await pullRemote();
      if (snapshot) applyRemoteSnapshot(snapshot);
    })();
  }, [session, applyRemoteSnapshot]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void flush();
    });
    return () => subscription.remove();
  }, []);
}
