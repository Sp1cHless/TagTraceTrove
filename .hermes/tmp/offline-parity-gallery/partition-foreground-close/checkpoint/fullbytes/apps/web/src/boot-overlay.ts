import type { OfflineApiState } from './offline/offline-api.js';

/**
 * The boot screen.
 *
 * The markup and its style live in `index.html` (inline, in the document) so the icon is on
 * screen from the very first frame — before the bundle, before any stylesheet. This module
 * only decides when it goes away.
 *
 * "Settled" means the app has chosen a mode: the startup's own step of preferring the saved
 * offline copy is *not* something a person should see, so the screen stays until the
 * connection phase resolves either way. `GIVE_UP_MS` guarantees it can never hide a working
 * app, whatever happens to that phase.
 */
const BOOT_ELEMENT_ID = 't3-boot';
const FADE_MS = 220;
export const BOOT_GIVE_UP_MS = 4_000;

/** True once the app is no longer deciding: online, or offline with nothing to check. */
export function bootPhaseSettled(phase: OfflineApiState['connectionPhase']): boolean {
  return phase === null || phase === 'no-copy';
}

export function dismissBootOverlay(
  documentTarget: Document = document,
  timers: Pick<Window, 'setTimeout'> = globalThis,
): void {
  const element = documentTarget.getElementById(BOOT_ELEMENT_ID);
  if (element === null || element.dataset.leaving === '1') {
    return;
  }
  element.dataset.leaving = '1';
  element.classList.add('is-leaving');
  timers.setTimeout(() => {
    element.hidden = true;
  }, FADE_MS);
}

/**
 * Watches the connection phase and takes the boot screen away once it settles, or after the
 * give-up deadline. Returns a stop function, like the other startup helpers.
 */
export function settleBootOverlay(
  readPhase: () => OfflineApiState['connectionPhase'],
  options: { watch?: (notify: () => void) => () => void } = {},
): () => void {
  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    dismissBootOverlay();
  };
  const check = (): void => {
    if (bootPhaseSettled(readPhase())) dismiss();
  };
  check();
  const stopWatching = options.watch?.(check);
  const deadline = globalThis.setTimeout(dismiss, BOOT_GIVE_UP_MS);
  return () => {
    globalThis.clearTimeout(deadline);
    stopWatching?.();
  };
}
