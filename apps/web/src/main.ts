import './browser-compat.js';
import { createApp, reactive, watch } from 'vue';
import GalleryApp from './GalleryApp.vue';
import { createDefaultGalleryApi } from './api/gallery.js';
import { createOfflineAwareGalleryApi, type OfflineApiState } from './offline/offline-api.js';
import { createIndexedDbOfflineStore } from './offline/indexeddb-snapshot-store.js';
import { startMediaPreload } from './offline/offline-media-task.js';
import { startConnectionRecovery } from './offline/connection-recovery.js';
import { createAutomaticOfflineSync } from './offline/automatic-sync.js';
import { createShellLibraryIdSource } from './offline/native-shell-library-id.js';
import { ServerProbeTimeout } from './offline/connection-recovery.js';
import { isOfflineTransportError } from './api/transport-error.js';
import { retireNativeShellServiceWorker } from './offline/native-shell-service-worker.js';
import { createNativeTransfers, nativeTransferPlugin } from './offline/native-background-transfer.js';
import { installClientErrorCapture } from './client-errors.js';
import { useI18n } from './i18n.js';
import { settleBootOverlay } from './boot-overlay.js';
import './styles/theme.css';
import './styles/smiley-sans.css';
import './styles/lxgw-wenkai.css';

// From the first moment: the System page can only show what was captured while the app ran.
installClientErrorCapture();

if (document.documentElement.dataset.t3UnsupportedBrowser !== '1') {
const { t } = useI18n();
const offlineStore = createIndexedDbOfflineStore();
const offlineState = reactive<OfflineApiState>({
  mode: 'online',
  lastFallbackAt: null,
  connectionPhase: 'checking',
  lastLocalLoadMs: null,
  pendingCount: 0,
  conflictCount: 0,
  failedCount: 0,
  lastReplayError: null,
  lastCapabilityProbe: null,
  lastSuccessfulCapabilityProbe: null,
  lastMutationDiagnostic: null,
  mutationDiagnostics: [],
});
const transferPlugin = nativeTransferPlugin();
const nativeTransfers = transferPlugin ? createNativeTransfers(offlineStore, transferPlugin,{isEditing:()=>!document.hidden}) : undefined;
// Local drafts stay editable in the foreground. Crossing into background is a
// submission boundary: freeze the current bodies atomically before mirroring.
document.addEventListener('visibilitychange',()=>{if(document.hidden)void nativeTransfers?.handoff().catch(()=>undefined);});
globalThis.addEventListener('pagehide',()=>{void nativeTransfers?.handoff().catch(()=>undefined);});
// The native shell knows which library the device is paired to. Before serving
// an offline snapshot the facade asks: a copy downloaded from a different
// library (an old pairing) must not render as if it were this library. The
// answer is remembered (see the module) so an offline read never waits on a
// bridge call; pairing can change while the page is hidden, so it is forgotten
// whenever the page comes back into view or regains focus.
const shellLibraryId = createShellLibraryIdSource({
  bridge: (globalThis as unknown as {
    Capacitor?: { nativePromise?: (plugin: string, method: string, args: Record<string, unknown>) => Promise<unknown> };
  }).Capacitor,
  isNativeShell: () => document.querySelector('meta[name="t3-native-shell"]') !== null,
});
const forgetShellLibraryId = (): void => shellLibraryId.invalidate();
globalThis.addEventListener('focus', forgetShellLibraryId);
globalThis.addEventListener('online', forgetShellLibraryId);
document.addEventListener('visibilitychange', () => { if (!document.hidden) forgetShellLibraryId(); });
const nativeShellLibraryId = (): Promise<string | null> => shellLibraryId.read();
const api = createOfflineAwareGalleryApi(createDefaultGalleryApi(), offlineStore, {
  state: offlineState,
  ...(nativeTransfers ? { nativeTransfers } : {}),
  nativeShellLibraryId,
  fallbackLibraryMismatchMessage: t('app.libraryMismatch'),
});
// The boot screen (inline in index.html) is on screen already; this takes it away once the
// app has settled, so the startup's own offline-copy step is never what a person sees.
settleBootOverlay(() => offlineState.connectionPhase, {
  watch: (notify) => {
    const stop = watch(() => offlineState.connectionPhase, notify);
    return stop;
  },
});

const startupReady = api.preferOfflineSnapshot!().then((installed) => {
  if (!installed) offlineState.connectionPhase = 'checking';
  void nativeTransfers?.handoff().catch(() => undefined);
  if (typeof globalThis.caches !== 'undefined') {
    void startMediaPreload({ store: offlineStore, assetUrl: api.assetUrl,
      cacheStorage: globalThis.caches }).catch((cause: unknown) => console.warn('Foreground media preload paused', cause));
  }
}, () => { offlineState.connectionPhase = 'no-copy'; });
createApp(GalleryApp, { api, offlineStore, offlineState, startupReady }).mount('#app');

let stopConnectionRecovery: (() => void) | undefined;
const synchronizeAutomatically = createAutomaticOfflineSync({ api, store: offlineStore, state: offlineState });
// A successful foreground read can reconnect before the heartbeat does.
// Observe that transition too; the coordinator joins overlapping requests.
watch(() => offlineState.mode, (next, previous) => {
  if (previous === 'offline' && next === 'online') void synchronizeAutomatically(true);
});
// Persistence is best-effort. Lack of a grant is reported, never an editing gate.
void navigator.storage?.persist?.().catch(() => undefined);
void startupReady.then(() => {
  stopConnectionRecovery = startConnectionRecovery({
    probe: async () => {
      await api.getSyncCapabilities({ replay: false });
    },
    isOffline: () => offlineState.mode === 'offline',
    isVisible: () => !document.hidden,
    onlineIntervalMs: 4_000,
    probeTimeoutMs: 2_500,
    onProbeSuccess(wasOffline) {
      void synchronizeAutomatically(wasOffline);
    },
    onProbeFailure(error) {
      if (!isOfflineTransportError(error) && !(error instanceof ServerProbeTimeout)) return;
      if (offlineState.mode === 'offline') return;
      // The decision first, the phase second: a client without a usable copy
      // must settle at 'no-copy' instead of flashing the online empty home
      // through 'switching' on every failed probe.
      void api.preferOfflineSnapshot!('disconnect').then((installed) => {
        if (!installed) offlineState.connectionPhase = 'no-copy';
      }, () => { offlineState.connectionPhase = 'no-copy'; });
    },
    windowTarget: window,
    documentTarget: document,
  });
});
if (import.meta.hot) import.meta.hot.dispose(() => stopConnectionRecovery?.());

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
}
