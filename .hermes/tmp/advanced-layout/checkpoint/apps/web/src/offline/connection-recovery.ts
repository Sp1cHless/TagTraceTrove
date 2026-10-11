interface EventTargetLike {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export class ServerProbeTimeout extends Error {
  constructor() {
    super('The desktop server did not respond to the health check');
    this.name = 'ServerProbeTimeout';
  }
}

export interface ConnectionRecoveryOptions {
  probe(): Promise<unknown>;
  isOffline(): boolean;
  isVisible(): boolean;
  onProbeFailure?(error: unknown): void;
  onProbeSuccess?(wasOffline: boolean): void;
  intervalMs?: number;
  /** Optional lightweight heartbeat while online, to detect desktop shutdown. */
  onlineIntervalMs?: number;
  /** Deadline for the warning only; the native request remains in flight. */
  probeTimeoutMs?: number;
  windowTarget: EventTargetLike;
  documentTarget: EventTargetLike;
}

/** A successful capability response is the only authority for coming back online.
 * A stalled native request may take much longer to reject: warn promptly but do
 * not stack more native probes until the original request settles. */
export function startConnectionRecovery(options: ConnectionRecoveryOptions): () => void {
  let inFlight = false;
  let stopped = false;
  const probe = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    const wasOffline = options.isOffline();
    let notified = false;
    const deadline = options.probeTimeoutMs === undefined ? undefined : globalThis.setTimeout(() => {
      notified = true;
      if (!stopped) options.onProbeFailure?.(new ServerProbeTimeout());
    }, options.probeTimeoutMs);
    try {
      void options.probe().then(() => {
        if (!stopped) options.onProbeSuccess?.(wasOffline || options.isOffline());
      }).catch((error: unknown) => {
        if (!notified && !stopped) options.onProbeFailure?.(error);
      }).finally(() => {
        if (deadline !== undefined) globalThis.clearTimeout(deadline);
        inFlight = false;
      });
    } catch (error) {
      if (deadline !== undefined) globalThis.clearTimeout(deadline);
      inFlight = false;
      if (!stopped) options.onProbeFailure?.(error);
    }
  };
  const onResume = (): void => probe();
  const onVisibilityChange = (): void => {
    if (options.isVisible()) probe();
  };

  probe();
  options.windowTarget.addEventListener('online', onResume);
  options.windowTarget.addEventListener('focus', onResume);
  options.documentTarget.addEventListener('visibilitychange', onVisibilityChange);
  const offlineInterval = globalThis.setInterval(() => {
    if (options.isOffline() && options.isVisible()) probe();
  }, options.intervalMs ?? 15_000);
  const onlineInterval = options.onlineIntervalMs === undefined ? undefined : globalThis.setInterval(() => {
    if (!options.isOffline() && options.isVisible()) probe();
  }, options.onlineIntervalMs);

  return () => {
    stopped = true;
    globalThis.clearInterval(offlineInterval);
    if (onlineInterval !== undefined) globalThis.clearInterval(onlineInterval);
    options.windowTarget.removeEventListener('online', onResume);
    options.windowTarget.removeEventListener('focus', onResume);
    options.documentTarget.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
