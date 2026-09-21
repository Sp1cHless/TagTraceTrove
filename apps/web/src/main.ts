import { createApp, reactive } from 'vue';
import GalleryApp from './GalleryApp.vue';
import { createDefaultGalleryApi } from './api/gallery.js';
import { createOfflineAwareGalleryApi, type OfflineApiState } from './offline/offline-api.js';
import { createIndexedDbOfflineStore } from './offline/indexeddb-snapshot-store.js';
import { startConnectionRecovery } from './offline/connection-recovery.js';
import { retireNativeShellServiceWorker } from './offline/native-shell-service-worker.js';
import './styles/theme.css';

const offlineStore = createIndexedDbOfflineStore();
const offlineState = reactive<OfflineApiState>({
  mode: 'online',
  lastFallbackAt: null,
  pendingCount: 0,
  conflictCount: 0,
  failedCount: 0,
  lastReplayError: null,
  lastCapabilityProbe: null,
  lastSuccessfulCapabilityProbe: null,
  lastMutationDiagnostic: null,
  mutationDiagnostics: [],
});
const api = createOfflineAwareGalleryApi(createDefaultGalleryApi(), offlineStore, { state: offlineState });
createApp(GalleryApp, { api, offlineStore, offlineState }).mount('#app');

const stopConnectionRecovery = startConnectionRecovery({
  probe: () => api.getSyncCapabilities(),
  isOffline: () => offlineState.mode === 'offline',
  isVisible: () => !document.hidden,
  windowTarget: window,
  documentTarget: document,
});
if (import.meta.hot) import.meta.hot.dispose(stopConnectionRecovery);

// Browser/PWA builds register the service worker. Capacitor ships the shell in
// the APK, so keeping a PWA worker there can serve an older bundle after an APK
// upgrade. Retire only shell workers/caches; preserve IndexedDB and media.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const nativeShell = document.querySelector('meta[name="t3-native-shell"]') !== null;
  if (nativeShell) {
    void retireNativeShellServiceWorker({
      registrations: () => navigator.serviceWorker.getRegistrations(),
      cacheKeys: () => caches.keys(),
      deleteCache: (name) => caches.delete(name),
      hasController: navigator.serviceWorker.controller !== null,
      getSessionItem: (key) => sessionStorage.getItem(key),
      setSessionItem: (key, value) => sessionStorage.setItem(key, value),
      reload: () => window.location.reload(),
    });
  } else {
    void navigator.serviceWorker.register('/sw.js');
  }
}