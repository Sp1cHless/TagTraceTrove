import { createApp, reactive } from 'vue';
import GalleryApp from './GalleryApp.vue';
import { createDefaultGalleryApi } from './api/gallery.js';
import { createOfflineAwareGalleryApi, type OfflineApiState } from './offline/offline-api.js';
import { createIndexedDbSnapshotStore } from './offline/indexeddb-snapshot-store.js';
import './styles/theme.css';

const offlineStore = createIndexedDbSnapshotStore();
const offlineState = reactive<OfflineApiState>({ mode: 'online', lastFallbackAt: null });
const api = createOfflineAwareGalleryApi(createDefaultGalleryApi(), offlineStore, { state: offlineState });
createApp(GalleryApp, { api, offlineStore, offlineState }).mount('#app');

// PWA shell (plan §23.6): production builds register the service worker for
// the versioned app shell + navigation fallback. Dev never caches.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js');
}