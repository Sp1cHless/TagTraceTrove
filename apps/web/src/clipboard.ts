/** Permissions vary across WebViews and plain LAN browser origins. */
export async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* Continue with the native/local user-initiated fallback. */ }
  const bridge = (window as unknown as { Capacitor?: { nativePromise?: (plugin: string, method: string, args: Record<string, unknown>) => Promise<unknown> } }).Capacitor;
  if (document.querySelector('meta[name="t3-native-shell"]') && bridge?.nativePromise) {
    try {
      await bridge.nativePromise('T3PairedTransport', 'copyText', { text });
      return;
    } catch { /* An older shell can still use the document fallback. */ }
  }
  const focused = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text;
  field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable; select and copy the displayed text. / 无法自动复制，请长按已显示的文字手动复制。');
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
  }
}
