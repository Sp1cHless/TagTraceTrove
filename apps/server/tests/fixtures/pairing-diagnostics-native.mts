import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { privateHttpsHost, startSecurePairingListener } from '../../src/http/secure-pairing.js';

const address = Object.values(networkInterfaces()).flat().find(item => {
  if (!item || item.family !== 'IPv4' || item.internal) return false;
  try { privateHttpsHost(item.address); return true; } catch { return false; }
})?.address;
if (!address) throw new Error('An isolated native TLS check requires a private IPv4 interface');
const directory = await mkdtemp(join(tmpdir(), 't3-pairing-diagnostic-'));
const logs: string[] = [];
const originalWarn = console.warn;
console.warn = (value: unknown) => { logs.push(String(value)); };
let mode = 'normal';
const runtime = await startSecurePairingListener({
  configDirectory: directory, libraryId: 'diagnostic-fixture-library', hostname: address,
  advertisedHost: address, port: 0,
  fetch: async () => mode === 'reject' ? Response.json({ error: { code: 'TEST_REFUSAL' } }, { status: 503 })
    : mode === 'invalid-response' ? new Response('invalid JSON')
      : Response.json({ libraryId: mode === 'wrong-library' ? 'other-library' : 'diagnostic-fixture-library' }),
});
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
output(runtime.issue());
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line) as { action: string; mode?: string; payload?: unknown };
    if (command.action === 'offer') output(runtime.issue());
    else if (command.action === 'mode') { mode = command.mode ?? 'normal'; output({ ok: true }); }
    else if (command.action === 'logs') output({ logs });
    else if (command.action === 'bridge') {
      // Execute the production diagnostic reader without a desktop connection or credential.
      const { readNativePairingDiagnostics } = await import('../../../web/src/pairing-diagnostics.js');
      let nativeShell = false;
      const bridge = { nativePromise: async (plugin: string, method: string, args: object) => {
        if (plugin !== 'T3PairedTransport' || method !== 'diagnostics' || Object.keys(args).length) throw new Error('Unexpected diagnostic authority');
        return command.payload;
      } };
      Object.assign(globalThis, { document: { querySelector: () => nativeShell ? {} : null }, window: { Capacitor: bridge } });
      const desktop = await readNativePairingDiagnostics();
      nativeShell = true;
      const diagnostic = await readNativePairingDiagnostics();
      bridge.nativePromise = async () => { throw new Error('bridge unavailable'); };
      const unavailable = await readNativePairingDiagnostics();
      bridge.nativePromise = () => new Promise(() => {});
      const timeout = await readNativePairingDiagnostics();
      output({ desktop, diagnostic, unavailable, timeout });
    }
    else if (command.action === 'close') break;
  }
} finally {
  await runtime.close(); console.warn = originalWarn;
  await rm(directory, { recursive: true, force: true });
}
