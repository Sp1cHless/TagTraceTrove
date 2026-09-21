// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startConnectionRecovery } from '../src/offline/connection-recovery.js';

describe('connection recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('probes on startup and app resume, and polls only while offline', () => {
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
    vi.advanceTimersByTime(15_000);
    expect(probe).toHaveBeenCalledTimes(1);

    state.mode = 'offline';
    vi.advanceTimersByTime(15_000);
    expect(probe).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event('focus'));
    expect(probe).toHaveBeenCalledTimes(3);

    visible = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(probe).toHaveBeenCalledTimes(3);
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(probe).toHaveBeenCalledTimes(4);

    stop();
    vi.advanceTimersByTime(15_000);
    window.dispatchEvent(new Event('online'));
    expect(probe).toHaveBeenCalledTimes(4);
  });
});
