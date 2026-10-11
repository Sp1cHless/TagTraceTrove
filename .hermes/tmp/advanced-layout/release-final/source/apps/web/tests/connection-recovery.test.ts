// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startConnectionRecovery } from '../src/offline/connection-recovery.js';

describe('connection recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('probes on startup and app resume, and polls only while offline', async () => {
    vi.useFakeTimers();
    const state = { mode: 'online' as 'online' | 'offline' };
    const probe = vi.fn(async () => undefined);
    let visible = true;
    const stop = startConnectionRecovery({
      probe,
      isOffline: () => state.mode === 'offline',
      isVisible: () => visible,
      intervalMs: 15_000,
      windowTarget: window,
      documentTarget: document,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(1);

    state.mode = 'offline';
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event('focus'));
    expect(probe).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    visible = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(probe).toHaveBeenCalledTimes(3);
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(probe).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(15_000);
    window.dispatchEvent(new Event('online'));
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('notifies promptly on a stalled server probe and does not stack native requests', async () => {
    vi.useFakeTimers();
    let resolveProbe: (() => void) | undefined;
    const probe = vi.fn(() => new Promise<void>((resolve) => { resolveProbe = resolve; }));
    let offline = false;
    const onProbeFailure = vi.fn<(error: unknown) => void>(() => { offline = true; });
    const onProbeSuccess = vi.fn();
    const stop = startConnectionRecovery({
      probe, onProbeFailure, onProbeSuccess, probeTimeoutMs: 2_000, intervalMs: 5_000, onlineIntervalMs: 5_000,
      isOffline: () => offline, isVisible: () => true,
      windowTarget: window, documentTarget: document,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onProbeFailure).toHaveBeenCalledOnce();
    expect(onProbeFailure.mock.calls[0]?.[0]).toMatchObject({ name: 'ServerProbeTimeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledOnce(); // native fetch still pending
    resolveProbe?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onProbeSuccess).toHaveBeenCalledWith(true);
    expect(probe).toHaveBeenCalledTimes(2);
    stop();
  });

  it('reports a successful offline probe for a foreground retry but not a failed or stopped probe', async () => {
    const state = { offline: true };
    const onProbeSuccess = vi.fn();
    const probe = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'));
    const stop = startConnectionRecovery({
      probe, onProbeSuccess,
      isOffline: () => state.offline, isVisible: () => true,
      windowTarget: window, documentTarget: document,
    });
    await vi.waitFor(() => expect(onProbeSuccess).toHaveBeenCalledWith(true));
    state.offline = false;
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    expect(onProbeSuccess).toHaveBeenCalledTimes(1);
    stop();
    window.dispatchEvent(new Event('online'));
    expect(onProbeSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not resume media work when a successful native response arrives after cleanup', async () => {
    let resolveProbe!: () => void;
    const onProbeSuccess = vi.fn();
    const stop = startConnectionRecovery({
      probe: () => new Promise<void>((resolve) => { resolveProbe = resolve; }),
      onProbeSuccess, isOffline: () => true, isVisible: () => true,
      windowTarget: window, documentTarget: document,
    });
    stop();
    resolveProbe();
    await Promise.resolve();
    await Promise.resolve();
    expect(onProbeSuccess).not.toHaveBeenCalled();
  });

  it('reports actual probe transport failures once and ignores late failures after stop', async () => {
    const onProbeFailure = vi.fn();
    const probe = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const stop = startConnectionRecovery({
      probe, onProbeFailure,
      isOffline: () => false, isVisible: () => true,
      windowTarget: window, documentTarget: document,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onProbeFailure).toHaveBeenCalledTimes(1);
    stop();
  });
});
