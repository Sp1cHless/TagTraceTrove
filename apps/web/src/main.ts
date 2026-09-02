import { createApp } from 'vue';
import GalleryApp from './GalleryApp.vue';
import { createDefaultGalleryApi } from './api/gallery.js';
import './styles/theme.css';

createApp(GalleryApp, { api: createDefaultGalleryApi() }).mount('#app');