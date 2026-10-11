import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      // Data, not source, and it is now in two places: T³'s own `.data/` at the root, and the
      // SiteProbe home inside `apps/server/.data/` (the tool's venv, browser profiles and page
      // caches live under it). Linting Chrome's bundled extension scripts found 34k problems and
      // hid every real one.
      '**/.data/**',
      '**/.venv/**',
      '.hermes/**',
      '.zcode/**',
      'spikes/**/android/**',
      'spikes/**/web-dist/**',
      // Ad-hoc measurement scripts for the phone's WebView debugger: tooling, not
      // application source, and they run with the bundled Node's globals.
      'spikes/**/device-probes/**',
      // A build-time generator (it needs sharp, so it lives beside the server); it runs
      // under Node's globals and writes image files, not application source.
      'apps/server/scripts/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
