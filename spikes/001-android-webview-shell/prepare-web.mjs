import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../apps/web/dist');
const target = resolve(here, 'web-dist');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const indexPath = resolve(target, 'index.html');
let html = await readFile(indexPath, 'utf8');
const pairingBootstrap = String.raw`
    <meta name="t3-api-base-url" content="https://localhost/api/">
    <script>
      (() => {
        // The local virtual origin never exposes credentials to JS. Native resolves it via pinned TLS.
        const originalFetch = window.fetch.bind(window);
        const native = (method, args) => window.Capacitor.nativePromise('T3PairedTransport', method, args);
        window.fetch = async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url, location.href);
          if (url.origin !== 'https://localhost' || !url.pathname.startsWith('/api/')) return originalFetch(input, init);
          if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          let body;
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            const bytes = new Uint8Array(await request.arrayBuffer());
            let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            body = btoa(binary);
          }
          let result;
          try { result = await native('request', { path: url.pathname + url.search, method: request.method, contentType: request.headers.get('content-type'), body }); }
          catch (error) {
            if (error.code === 'NETWORK_UNAVAILABLE') throw new TypeError('Native network unavailable');
            const chinese = (navigator.language || '').toLowerCase().startsWith('zh');
            return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: chinese ? '请先配对桌面资料库，或在设置中重新配对；离线副本和待同步改动会保留。' : 'Pair to your desktop library, or re-pair from Settings. Offline work is preserved.' } }), { status: 401, headers: { 'content-type': 'application/json' } });
          }
          if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const bytes = Uint8Array.from(atob(result.body), char => char.charCodeAt(0));
          const response = new Response(result.status === 204 || request.method === 'HEAD' ? null : bytes, { status: result.status, headers: { 'content-type': result.contentType || 'application/octet-stream' } });
          Object.defineProperty(response, 'url', { value: result.url || request.url });
          return response;
        };
        window.addEventListener('DOMContentLoaded', () => {
          const unsupported = document.documentElement.getAttribute('data-t3-unsupported-browser') === '1';
          native('status', {}).then(status => { if (!unsupported && !status.paired) return native('pair', {}); }).catch(() => { if (!unsupported) return native('pair', {}); });
        });
      })();
    </script>`;

const nativeShellMarker = '    <meta name="t3-native-shell" content="android">';
html = html.replace('</head>', `${nativeShellMarker}\n${pairingBootstrap}\n  </head>`);
await writeFile(indexPath, html);

// An installed APK may reopen a WebView document still controlled by the old
// PWA worker. The Android-only worker update claims and navigates that document
// once; the new main bundle then unregisters the worker without clearing
// IndexedDB, Outbox, or the independent offline-media cache.
const serviceWorkerPath = resolve(target, 'sw.js');
let serviceWorker = await readFile(serviceWorkerPath, 'utf8');
serviceWorker += String.raw`

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url).catch(() => undefined)))),
  );
});
`;
await writeFile(serviceWorkerPath, serviceWorker);
process.stdout.write(`Prepared ${target}\n`);
