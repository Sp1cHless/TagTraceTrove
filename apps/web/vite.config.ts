import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import vue from '@vitejs/plugin-vue';
import { build, defineConfig, type Plugin } from 'vite';

function serviceWorkerPlugin(): Plugin {
  return {
    name: 't3-service-worker',
    apply: 'build',
    closeBundle: {
      order: 'post',
      async handler() {
        // The guarded env flag keeps the nested lib build (which also applies
        // build plugins) from recursing into itself.
        if (process.env.T3_SW_BUILD === '1') return;
        process.env.T3_SW_BUILD = '1';
        try {
          const builtHtml = await readFile(resolve(__dirname, 'dist/index.html'), 'utf8');
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
              emptyOutDir: false,
              lib: {
                entry: resolve(__dirname, 'src/sw/service-worker.ts'),
                formats: ['es'],
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
});
