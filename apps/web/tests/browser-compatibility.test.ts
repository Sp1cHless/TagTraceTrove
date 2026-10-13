// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import postcss from 'postcss';
import { browserCssCompatibility } from '../browser-build-compat.js';
import { copyText } from '../src/clipboard.js';
import { ApiError } from '../src/api/client.js';
import { readFileSync } from 'node:fs';

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelector('meta[name="t3-native-shell"]')?.remove();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('browser compatibility', () => {
  it('retains authorization and forbidden explanations with their HTTP status', () => {
    for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN']] as const) {
      expect(new ApiError(status, { error: { code, message: 'Pair again' } })).toMatchObject({ status, message: 'Pair again' });
    }
  });

  it('guards variable colours and provides viewport/container layout fallbacks', async () => {
    const source = '.panel { --accent-soft: color-mix(in srgb, var(--accent) 12%, var(--surface)); height: calc(100dvh - 2rem); border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent); } @container (max-width: 44rem) { .row { display: block } }';
    const result = await postcss([browserCssCompatibility()]).process(source, { from: undefined });
    const base = result.root.nodes[0];
    expect(base.toString()).toContain('--accent-soft: var(--surface-muted)');
    expect(base.toString()).toContain('calc(100vh - 2rem)');
    expect(base.toString()).toContain('border: 1px solid var(--border-subtle)');
    expect(base.toString()).not.toContain('color-mix');
    expect(result.css).toContain('@supports (color: color-mix(in srgb, black, white))');
    expect(result.css).toContain('@supports not (container-type: inline-size)');
    expect(result.css).toContain('@media (max-width: 44rem)');
  });

  it('uses native copying when the WebView clipboard is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    document.head.appendChild(Object.assign(document.createElement('meta'), { name: 't3-native-shell', content: 'android' }));
    const nativePromise = vi.fn().mockResolvedValue({});
    (window as unknown as { Capacitor: unknown }).Capacitor = { nativePromise };
    await copyText('device diagnostics');
    expect(nativePromise).toHaveBeenCalledWith('T3PairedTransport', 'copyText', { text: 'device diagnostics' });
  });

  it('copies without a secure Clipboard API and cleans the temporary field', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const focused = document.createElement('button');
    document.body.appendChild(focused);
    focused.focus();
    const exec = vi.fn(() => document.querySelector('textarea')?.value === 'report');
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    await copyText('report');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(focused);
    focused.remove();
  });

  it('shows standalone diagnostics for an engine too old to run the app', () => {
    const script = readFileSync('apps/web/public/browser-check.js', 'utf8');
    const original = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome/80.0.0.0' });
    window.eval(script);
    expect(document.querySelector('#t3-browser-recovery textarea')?.textContent).toBeDefined();
    expect((document.querySelector('#t3-browser-recovery textarea') as HTMLTextAreaElement).value).toContain('Chrome/80');
    expect(document.documentElement.dataset.t3UnsupportedBrowser).toBe('1');
    document.querySelector('#t3-browser-recovery')?.remove();
    delete document.documentElement.dataset.t3UnsupportedBrowser;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: original });
  });
});
