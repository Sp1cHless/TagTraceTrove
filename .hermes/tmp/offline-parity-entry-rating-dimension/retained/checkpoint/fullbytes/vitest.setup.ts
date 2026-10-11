// Node's bundled jsdom does not always expose window.localStorage (it depends
// on the Node build and how the jsdom window is created). T3 preferences,
// view-later state and several tests persist through localStorage, so provide
// a minimal in-memory Storage shim when the platform lacks one. The shim is
// per test file: vitest re-runs setup files for every environment instance.
function installStorageShim(target: Record<string, unknown>, key: string): void {
  if (typeof target[key] !== 'undefined') return;
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (storageKey) => (store.has(storageKey) ? store.get(storageKey)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (storageKey) => {
      store.delete(storageKey);
    },
    setItem: (storageKey, value) => {
      store.set(storageKey, String(value));
    },
  };
  Object.defineProperty(target, key, { value: shim, configurable: true });
}

const host = typeof window !== 'undefined'
  ? (window as unknown as Record<string, unknown>)
  : (globalThis as unknown as Record<string, unknown>);
installStorageShim(host, 'localStorage');
installStorageShim(host, 'sessionStorage');
if (typeof globalThis.localStorage === 'undefined') {
  installStorageShim(globalThis as unknown as Record<string, unknown>, 'localStorage');
}
