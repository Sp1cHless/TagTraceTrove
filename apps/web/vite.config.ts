import { resolve } from 'node:path';
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
          await build({
            configFile: false,
            logLevel: 'error',
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
