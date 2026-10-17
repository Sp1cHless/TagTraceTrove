/** Available before pairing and without a reachable desktop. The native journal contains no credentials. */
export async function readNativePairingDiagnostics(): Promise<unknown> {
  if (document.querySelector('meta[name="t3-native-shell"]') === null) return null;
  const bridge = (window as unknown as {
    Capacitor?: { nativePromise?: (plugin: string, method: string, args: Record<string, unknown>) => Promise<unknown> };
  }).Capacitor;
  if (!bridge?.nativePromise) return { available: false, reason: 'NATIVE_BRIDGE_UNAVAILABLE' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bridge.nativePromise('T3PairedTransport', 'diagnostics', {}),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ available: false, reason: 'NATIVE_DIAGNOSTICS_TIMEOUT' }), 2000); }),
    ]);
  } catch {
    return { available: false, reason: 'NATIVE_DIAGNOSTICS_UNAVAILABLE' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
