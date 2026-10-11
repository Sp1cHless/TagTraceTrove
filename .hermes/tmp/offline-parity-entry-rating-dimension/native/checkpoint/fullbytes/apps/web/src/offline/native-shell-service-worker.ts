export interface NativeShellServiceWorkerDependencies {
  registrations(): Promise<readonly { unregister(): Promise<boolean> }[]>;
  cacheKeys(): Promise<string[]>;
  deleteCache(name: string): Promise<boolean>;
  hasController: boolean;
  getSessionItem(key: string): string | null;
  setSessionItem(key: string, value: string): void;
  reload(): void;
}

const RELOAD_GUARD_KEY = 't3.native-shell.sw-retired';

/**
 * Capacitor ships its app shell inside the APK. A PWA Service Worker can keep
 * an older installed bundle alive across APK upgrades, so retire it without
 * touching IndexedDB or the independent offline media cache.
 */
export async function retireNativeShellServiceWorker(
  dependencies: NativeShellServiceWorkerDependencies,
): Promise<void> {
  const registrations = await dependencies.registrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  const cacheKeys = await dependencies.cacheKeys();
  await Promise.all(cacheKeys
    .filter((name) => name.startsWith('t3-shell-'))
    .map((name) => dependencies.deleteCache(name)));

  if (dependencies.hasController && dependencies.getSessionItem(RELOAD_GUARD_KEY) !== '1') {
    dependencies.setSessionItem(RELOAD_GUARD_KEY, '1');
    dependencies.reload();
  }
}
