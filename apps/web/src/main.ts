import { createApp } from 'vue';
import GalleryApp from './GalleryApp.vue';
import { createDefaultGalleryApi } from './api/gallery.js';
import './styles/theme.css';

createApp(GalleryApp, { api: createDefaultGalleryApi() }).mount('#app');

// PWA shell (plan §23.6): production builds register the service worker for
// the versioned app shell + navigation fallback. Dev never caches.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js');
}