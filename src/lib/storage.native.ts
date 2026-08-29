import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { StateStorage } from 'zustand/middleware';
import { IS_EXPO_GO } from '@/lib/runtime';
import { safeAsync } from '@/lib/safeNative';

const ENCRYPTION_KEY_NAME = 'cineswipe.mmkv.key';

/**
 * Key/value persistence with two backends.
 *
 * Preferred: **encrypted MMKV**. Fast, synchronous, and the encryption key
 * lives in the OS keychain, so the cached premium entitlement can't be
 * tampered with by editing a file on disk.
 *
 * Fallback: **AsyncStorage**, used in Expo Go. `react-native-mmkv` is native
 * code that Expo Go does not contain — importing it throws "Cannot find native
 * module" and kills the app at load — whereas AsyncStorage is bundled in Expo
 * Go. It is NOT encrypted, so this path is for development convenience only;
 * real builds always get MMKV.
 */
interface Backend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  readonly encrypted: boolean;
}

let backend: Backend | null = null;

let resolveReady: () => void;
/** Resolves once a storage backend is available. */
export const storageReady: Promise<void> = new Promise((resolve) => {
  resolveReady = resolve;
});

async function encryptionKey(): Promise<string> {
  // Every native call is invoked inside safeAsync: expo modules can throw
  // synchronously during argument validation, which a trailing `.catch()`
  // would miss. A null anywhere here means "no keychain" and we fall through
  // to the unencrypted backend rather than crashing the app at boot.
  const existing = await safeAsync('SecureStore.getItemAsync', () =>
    SecureStore.getItemAsync(ENCRYPTION_KEY_NAME),
  );
  if (existing) return existing;

  const bytes = await safeAsync('Crypto.getRandomBytesAsync', () =>
    Crypto.getRandomBytesAsync(32),
  );
  if (!bytes) throw new Error('secure_random_unavailable');

  const key = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await safeAsync('SecureStore.setItemAsync', () =>
    SecureStore.setItemAsync(ENCRYPTION_KEY_NAME, key),
  );
  return key;
}

function asyncStorageBackend(): Backend {
  return {
    encrypted: false,
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: (key) => AsyncStorage.removeItem(key),
  };
}

/**
 * Selects and initialises a backend. Must complete before the store
 * rehydrates — the root layout awaits it.
 */
export async function initStorage(): Promise<void> {
  if (backend) return;

  if (IS_EXPO_GO) {
    backend = asyncStorageBackend();
    resolveReady();
    return;
  }

  try {
    // Lazily required: the import itself throws where the native module is absent.
    const { MMKV } = require('react-native-mmkv') as typeof import('react-native-mmkv');
    const mmkv = new MMKV({ id: 'cineswipe', encryptionKey: await encryptionKey() });
    backend = {
      encrypted: true,
      get: async (key) => mmkv.getString(key) ?? null,
      set: async (key, value) => mmkv.set(key, value),
      remove: async (key) => mmkv.delete(key),
    };
  } catch (err) {
    if (__DEV__) {
      console.warn('MMKV unavailable, falling back to AsyncStorage:', err);
    }
    backend = asyncStorageBackend();
  }
  resolveReady();
}

function requireBackend(): Backend {
  if (!backend) {
    throw new Error('Storage accessed before initStorage() completed');
  }
  return backend;
}

/** True when persisted values are encrypted at rest (i.e. MMKV is in use). */
export function storageIsEncrypted(): boolean {
  return backend?.encrypted ?? false;
}

/**
 * Adapter for zustand/persist. Asynchronous because AsyncStorage is — zustand
 * awaits these, and the root layout awaits `persist.rehydrate()`.
 */
export const zustandStorage: StateStorage = {
  getItem: (name) => requireBackend().get(name),
  setItem: (name, value) => requireBackend().set(name, value),
  removeItem: (name) => requireBackend().remove(name),
};

/** Adapter for the Supabase auth session — waits for storage init. */
export const supabaseAuthStorage = {
  getItem: async (key: string): Promise<string | null> => {
    await storageReady;
    return requireBackend().get(key);
  },
  setItem: async (key: string, value: string): Promise<void> => {
    await storageReady;
    await requireBackend().set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    await storageReady;
    await requireBackend().remove(key);
  },
};
