exec((__import__('pathlib').Path(__file__).parent/'options.py').read_text().split("patch('apps/web/src/offline/offline-library.ts'")[0])
patch('vitest.integration.config.ts', "import { configDefaults, defineConfig } from 'vitest/config';", """import { configDefaults, defineConfig } from 'vitest/config';
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
}""")
patch('vitest.integration.config.ts', "export default defineConfig({", "export default defineConfig({\n  plugins: [clientVue],")
