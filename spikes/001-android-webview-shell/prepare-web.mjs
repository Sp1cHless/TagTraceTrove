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
    <meta name="t3-api-base-url" content="">
    <script>
      (() => {
        const storageKey = 't3.mobile.spike.serverOrigin';
        const params = new URLSearchParams(window.location.search);
        if (params.get('resetPairing') === '1') localStorage.removeItem(storageKey);

        const isPrivateServer = (value) => {
          try {
            const url = new URL(value);
            const host = url.hostname;
            if (url.protocol !== 'http:') return null;
            const octets = host.split('.').map(Number);
            const privateIpv4 = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
              && (octets[0] === 10
                || octets[0] === 127
                || octets[0] === 192 && octets[1] === 168
                || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
            if (!privateIpv4 && host !== 'localhost') return null;
            url.pathname = '/';
            url.search = '';
            url.hash = '';
            return url.toString().replace(/\/$/u, '');
          } catch {
            return null;
          }
        };

        const savedOrigin = isPrivateServer(localStorage.getItem(storageKey) ?? '');
        if (savedOrigin) {
          document.querySelector('meta[name="t3-api-base-url"]').content = new URL('/api/', savedOrigin).toString();
        }

        window.addEventListener('DOMContentLoaded', () => {
          const renderPairing = () => {
            const overlay = document.createElement('div');
            overlay.id = 't3-mobile-pairing';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#0f172a;color:#e2e8f0;font:16px system-ui,sans-serif';
            overlay.innerHTML = '<form style="display:grid;gap:14px;width:min(100%,420px);padding:24px;border:1px solid #334155;border-radius:16px;background:#111827"><h1 style="margin:0;font-size:24px">Pair T³ Mobile</h1><p style="margin:0;color:#94a3b8">Enable LAN access on Desktop T³, then enter its private HTTP URL.</p><input name="server" required inputmode="url" placeholder="http://192.168.1.10:8765" style="padding:12px;border:1px solid #475569;border-radius:8px;font:inherit"><p data-error role="alert" style="display:none;margin:0;color:#fca5a5"></p><button type="submit" style="padding:12px;border:0;border-radius:8px;background:#2563eb;color:white;font:inherit;font-weight:700">Save and connect</button></form>';
            overlay.querySelector('form').addEventListener('submit', (event) => {
              event.preventDefault();
              const origin = isPrivateServer(new FormData(event.currentTarget).get('server'));
              const error = overlay.querySelector('[data-error]');
              if (!origin) {
                error.textContent = 'Use an HTTP localhost or private-LAN IPv4 URL.';
                error.style.display = 'block';
                return;
              }
              localStorage.setItem(storageKey, origin);
              window.location.replace(window.location.pathname);
            });
            document.body.append(overlay);
          };

          if (!savedOrigin) {
            renderPairing();
          }
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
