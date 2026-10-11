import { configDefaults, defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Real DOM callers run beside isolated SQL in Node. Compile Vue's client render,
// not SSR, without switching server modules to Vite's browser URL resolution.
const clientVue = vue();
const transformVue = clientVue.transform;
if (transformVue && typeof transformVue !== 'function') {
  const handler = transformVue.handler;
  clientVue.transform = { ...transformVue, handler(code, id, options) {
    return handler.call(this, code, id, { ...options, ssr: false });
  } };
}

export default defineConfig({
  plugins: [clientVue],
  test: {
    environment: 'node',
    include: ['**/*.integration.test.ts'],
    exclude: [...configDefaults.exclude, '.hermes/**'],
    passWithNoTests: false,
  },
});
