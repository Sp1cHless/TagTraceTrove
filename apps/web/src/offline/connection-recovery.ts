interface EventTargetLike {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface ConnectionRecoveryOptions {
  probe(): Promise<unknown>;
  isOffline(): boolean;
  isVisible(): boolean;
  intervalMs?: number;
  windowTarget: EventTargetLike;
  documentTarget: EventTargetLike;
}

/**
 * Wi-Fi staying connected does not emit an online event when only the desktop
 * T3 server returns. Poll capabilities while the app is in snapshot mode, and
 * also probe on startup/resume. Probe failures are deliberately silent; the
 * offline snapshot remains active until one succeeds.
 */
export function startConnectionRecovery(options: ConnectionRecoveryOptions): () => void {
  const probe = (): void => {
    void options.probe().catch(() => undefined);
  };
  const onResume = (): void => probe();
  const onVisibilityChange = (): void => {
    if (options.isVisible()) probe();
  };

  probe();
  options.windowTarget.addEventListener('online', onResume);
  options.windowTarget.addEventListener('focus', onResume);
  options.documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  const interval = globalThis.setInterval(() => {
    if (options.isOffline()) probe();
  }, options.intervalMs ?? 15_000);

  return () => {
    globalThis.clearInterval(interval);
    options.windowTarget.removeEventListener('online', onResume);
    options.windowTarget.removeEventListener('focus', onResume);
    options.documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
