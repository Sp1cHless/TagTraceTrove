// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_GIVE_UP_MS, bootPhaseSettled, dismissBootOverlay, settleBootOverlay } from '../src/boot-overlay.js';

/**
 * The boot screen is the first thing anyone sees, so its contract is narrow and worth
 * pinning: it must be there while the app is still deciding, it must go away once the app
 * has settled (never showing the startup's own offline-copy step), and it must never be
 * able to hide a working app.
 */
function bootElement(): HTMLElement {
  const element = document.createElement('div');
  element.id = 't3-boot';
  document.body.append(element);
  return element;
}

describe('the boot screen', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats only a resolved phase as settled', () => {
    expect(bootPhaseSettled(null)).toBe(true);
    expect(bootPhaseSettled('no-copy')).toBe(true);
    expect(bootPhaseSettled('checking')).toBe(false);
    expect(bootPhaseSettled('opening-copy')).toBe(false);
    expect(bootPhaseSettled('switching')).toBe(false);
  });

  it('fades the element out and then hides it, once', () => {
    const element = bootElement();
    dismissBootOverlay();
    expect(element.classList.contains('is-leaving')).toBe(true);
    expect(element.hidden).toBe(false);
    vi.advanceTimersByTime(300);
    expect(element.hidden).toBe(true);

    // A second dismissal must not restart anything.
    dismissBootOverlay();
    expect(element.dataset.leaving).toBe('1');
  });

  it('does nothing when there is no boot element', () => {
    expect(() => dismissBootOverlay()).not.toThrow();
  });

  it('stays up while the app is deciding, and goes away when it settles', () => {
    const element = bootElement();
    const state = { phase: 'opening-copy' as 'opening-copy' | null };
    settleBootOverlay(() => state.phase, { watch: () => () => undefined });
    vi.advanceTimersByTime(1_000);
    expect(element.classList.contains('is-leaving')).toBe(false);

    state.phase = null;
    dismissBootOverlay();
    expect(element.classList.contains('is-leaving')).toBe(true);
  });

  it('gives up rather than hiding a working app', () => {
    const element = bootElement();
    // A phase that never resolves: the deadline is the only way out.
    settleBootOverlay(() => 'checking', { watch: () => () => undefined });
    vi.advanceTimersByTime(BOOT_GIVE_UP_MS - 100);
    expect(element.classList.contains('is-leaving')).toBe(false);
    vi.advanceTimersByTime(200);
    expect(element.classList.contains('is-leaving')).toBe(true);
  });

  it('notifies through the watcher it is given', () => {
    bootElement();
    const state = { phase: 'checking' as 'checking' | null };
    let notify: (() => void) | undefined;
    settleBootOverlay(() => state.phase, { watch: (callback) => { notify = callback; return () => undefined; } });
    expect(notify).toBeTypeOf('function');
    state.phase = null;
    notify?.();
    expect(document.getElementById('t3-boot')?.classList.contains('is-leaving')).toBe(true);
  });
});
