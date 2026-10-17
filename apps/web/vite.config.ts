import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import vue from '@vitejs/plugin-vue';
import { build, defineConfig, type Plugin } from 'vite';
import { browserCssCompatibility } from './browser-build-compat.js';

const browserTarget = 'chrome90';

function serviceWorkerPlugin(): Plugin {
  let outputDirectory = resolve(__dirname, 'dist');
  return {
    name: 't3-service-worker',
    apply: 'build',
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      async handler() {
        // The guarded env flag keeps the nested lib build (which also applies
        // build plugins) from recursing into itself.
        if (process.env.T3_SW_BUILD === '1') return;
        process.env.T3_SW_BUILD = '1';
        try {
          const builtHtml = await readFile(resolve(outputDirectory, 'index.html'), 'utf8');
          const precacheUrls = [...builtHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)]
            .map((match) => match[1])
            .filter((url): url is string => url !== undefined);
          await build({
            configFile: false,
            logLevel: 'error',
            define: {
              __T3_PRECACHE_URLS__: JSON.stringify(precacheUrls),
            },
            build: {
              outDir: outputDirectory,
              target: browserTarget,
              emptyOutDir: false,
              lib: {
                entry: resolve(__dirname, 'src/sw/service-worker.ts'),
                // Registration uses a classic worker (including Chromium 90).
                // ES exports here make the browser reject sw.js at evaluation.
                formats: ['iife'],
                name: 'T3ServiceWorker',
                fileName: () => 'sw.js',
              },
            },
          });
        } finally {
          delete process.env.T3_SW_BUILD;
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [vue(), serviceWorkerPlugin()],
  build: { target: browserTarget, cssTarget: browserTarget },
  css: { postcss: { plugins: [browserCssCompatibility()] } },
});
