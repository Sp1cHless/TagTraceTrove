<script setup lang="ts">
import { ref } from 'vue';
const busy = ref(false);
const recovery = ref<{ libraryId: string; message: string } | null>(null);
const confirmLibrary = ref('');
const confirmOwner = ref('');
async function recover(action: 'recover-lock' | 'reset-identity'): Promise<void> {
  if (busy.value || confirmLibrary.value !== recovery.value?.libraryId || !/^(0|[1-9][0-9]*)$/.test(confirmOwner.value)) return;
  busy.value = true; issue.value = null;
  try {
    await admin('recover', { libraryId: confirmLibrary.value, ownerPid: Number(confirmOwner.value), action });
    recovery.value = null; image.value = null; payload.value = null;
    issue.value = 'Recovery completed. Create a new QR and explicitly re-pair. Your offline copy and queued edits were kept.';
  } catch (cause) { issue.value = cause instanceof Error ? cause.message : 'Recovery refused'; }
  finally { busy.value = false; }
}
const issue = ref<string | null>(null);
const image = ref<string | null>(null);
const payload = ref<string | null>(null);
const devices = ref<{ deviceId: string; deviceName: string; revoked: boolean }[]>([]);
const native = typeof document !== 'undefined' && document.querySelector('meta[name="t3-native-shell"]') !== null;
async function admin(path: string, body?: unknown): Promise<unknown> {
  const status = await fetch('/api/pairing/status', { headers: { 'x-t3-desktop': '1' } });
  if (!status.ok) throw new Error('Encrypted pairing is not enabled here. Start desktop with a private T3_PAIRED_HOST; legacy LAN HTTP is limited development transport, not secure pairing.');
  const state = await status.json() as { csrf: string; devices: typeof devices.value; recovery?: typeof recovery.value };
  recovery.value = state.recovery ?? null;
  devices.value = state.devices;
  if (path === 'status') return state;
  const response = await fetch(`/api/pairing/${path}`, { method: 'POST', headers: { 'x-t3-csrf': state.csrf, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error('Desktop pairing authorization rejected');
  return response.json() as Promise<unknown>;
}
async function issueQr(): Promise<void> {
  if (busy.value) return; busy.value = true; issue.value = null;
  try {
    const result = await admin('offer') as { svg: string; payload: unknown };
    image.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`; payload.value = JSON.stringify(result.payload);
  } catch (cause) { issue.value = cause instanceof Error ? cause.message : 'Pairing unavailable'; }
  finally { busy.value = false; }
}
async function revoke(deviceId: string): Promise<void> {
  if (busy.value) return; busy.value = true; issue.value = null;
  try { const result = await admin('revoke', { deviceId }) as { devices: typeof devices.value }; devices.value = result.devices; }
  catch (cause) { issue.value = cause instanceof Error ? cause.message : 'Revocation failed'; }
  finally { busy.value = false; }
}
async function forget(deviceId: string): Promise<void> {
  if (busy.value) return; busy.value = true; issue.value = null;
  try { const result = await admin('forget', { deviceId }) as { devices: typeof devices.value }; devices.value = result.devices; }
  catch (cause) { issue.value = cause instanceof Error ? cause.message : 'Removing the record failed'; }
  finally { busy.value = false; }
}
async function refreshDevices(): Promise<void> {
  issue.value = null;
  try { await admin('status'); } catch (cause) { issue.value = cause instanceof Error ? cause.message : 'Pairing unavailable'; }
}
function pairNative(): void {
  const bridge = (window as unknown as { Capacitor?: { nativePromise(plugin: string, method: string, args: object): Promise<unknown> } }).Capacitor;
  void bridge?.nativePromise('T3PairedTransport', 'pair', {});
}
</script>
<template>
  <section class="secure-pairing-settings" data-testid="secure-pairing-settings">
    <strong>Connect to APP</strong>
    <template v-if="native"><button type="button" @click="pairNative">Scan desktop QR / re-pair</button><small>Certificate or authorization failures never clear queued work.</small></template>
    <template v-else>
      <!-- The two everyday actions share one row, half of it each, in the app's
           usual button shape: this sheet is a quick pass, not a page. -->
      <div class="pairing-actions">
        <button class="secondary-button" type="button" :disabled="busy" @click="issueQr">Create pairing QR (expires in 2 minutes)</button>
        <button class="secondary-button" type="button" :disabled="busy" @click="refreshDevices">Authorized devices</button>
      </div>
      <fieldset v-if="recovery" data-testid="pairing-recovery">
        <legend>Explicit encrypted connection recovery</legend>
        <p>{{ recovery.message }}</p>
        <p>Stop the previous server first. Verify its actual PID locally (Task Manager or the recorded process report); if a crash left the PID marker empty, explicitly enter that recorded actual PID, never a guessed PID. A live or unknown owner is never cleared. No library files, offline copy and queued edits are deleted.</p>
        <label>Type current library identity: {{ recovery.libraryId }}<input v-model="confirmLibrary" data-testid="confirm-library"></label>
        <label>Verified previous owner PID (0 only when no lock exists)<input v-model="confirmOwner" data-testid="confirm-owner" inputmode="numeric"></label>
        <button type="button" data-testid="recover-lock" :disabled="busy || confirmLibrary !== recovery.libraryId || !/^(0|[1-9][0-9]*)$/.test(confirmOwner)" @click="recover('recover-lock')">Confirm dead-owner lock recovery (keep certificate)</button>
        <button type="button" :disabled="busy || confirmLibrary !== recovery.libraryId || !/^(0|[1-9][0-9]*)$/.test(confirmOwner)" @click="recover('reset-identity')">Confirm replace certificate and revoke every device / old QR</button>
      </fieldset>
      <img v-if="image" :src="image" alt="One-time encrypted mobile pairing QR" width="320" height="320">
      <label v-if="payload">Copy/paste fallback (not a camera scan)<textarea :value="payload" readonly /></label>
      <div v-for="device in devices" :key="device.deviceId"><span>{{ device.deviceName }} — {{ device.revoked ? 'revoked' : 'authorized' }}</span><button v-if="!device.revoked" type="button" :disabled="busy" @click="revoke(device.deviceId)">Revoke device</button><button v-else type="button" :disabled="busy" :data-forget-device-id="device.deviceId" @click="forget(device.deviceId)">Remove record</button></div>
    </template>
    <p v-if="issue" role="alert">{{ issue }}</p>
  </section>
</template>
<style scoped>
.secure-pairing-settings { display: grid; gap: .65rem; padding-block: 1rem; }
.pairing-actions { display: flex; align-items: stretch; gap: .5rem; }
.pairing-actions button { flex: 1 1 0; min-width: 0; }
textarea { display: block; width: 100%; min-height: 5rem; }
img { max-width: 100%; height: auto; background: white; }
button { min-height: 44px; }
</style>
