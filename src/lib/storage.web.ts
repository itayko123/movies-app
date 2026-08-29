import type { StateStorage } from 'zustand/middleware';

/**
 * Web shim for the storage layer.
 *
 * Native uses encrypted MMKV keyed from the OS keychain; the browser has no
 * equivalent, so web falls back to localStorage (with an in-memory Map when
 * localStorage is unavailable, e.g. during static rendering or private
 * browsing). Web builds exist for quick UI testing — the entitlement cache
 * here is display-only and carries no offline-trust guarantees.
 */

const memory = new Map<string, string>();

function browserStorage(): { get: (k: string) => string | null; set: (k: string, v: string) => void; remove: (k: string) => void } {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (ls) {
    return {
      get: (k) => ls.getItem(k),
      set: (k, v) => ls.setItem(k, v),
      remove: (k) => ls.removeItem(k),
    };
  }
  return {
    get: (k) => memory.get(k) ?? null,
    set: (k, v) => {
      memory.set(k, v);
    },
    remove: (k) => {
      memory.delete(k);
    },
  };
}

/** Web storage is synchronous — ready immediately. */
export const storageReady: Promise<void> = Promise.resolve();

export async function initStorage(): Promise<void> {
  // No-op on web: nothing to decrypt, no keychain to consult.
}

/** Browser storage is never encrypted at rest — parity with the native API. */
export function storageIsEncrypted(): boolean {
  return false;
}

export const zustandStorage: StateStorage = {
  setItem: (name, value) => browserStorage().set(name, value),
  getItem: (name) => browserStorage().get(name),
  removeItem: (name) => browserStorage().remove(name),
};

export const supabaseAuthStorage = {
  getItem: async (key: string): Promise<string | null> => browserStorage().get(key),
  setItem: async (key: string, value: string): Promise<void> => {
    browserStorage().set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    browserStorage().remove(key);
  },
};
