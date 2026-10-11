// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createI18nState, messages } from '../src/i18n.js';

function storage(initial: string | null) {
  const map = new Map<string, string>();
  if (initial !== null) map.set('t3.locale', initial);
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}

describe('the starting locale', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('follows a device that asks for Chinese', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN', 'en'] });
    expect(createI18nState(storage(null)).locale.value).toBe('zh-CN');
  });

  it('starts in English for anything else', () => {
    vi.stubGlobal('navigator', { language: 'de-DE', languages: ['de-DE'] });
    expect(createI18nState(storage(null)).locale.value).toBe('en');
  });

  it('lets a stored choice win over the device', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN'] });
    expect(createI18nState(storage('en')).locale.value).toBe('en');
  });
});

describe('UI i18n', () => {
  it('provides complete English and Simplified Chinese dictionaries', () => {
    expect(Object.keys(messages.en)).toEqual(Object.keys(messages['zh-CN']));
    expect(messages.en['settings.title']).toBe('Settings');
    expect(messages['zh-CN']['settings.title']).toBe('设置');
  });

  it('restores and persists the selected locale', () => {
    window.localStorage.setItem('t3.locale', 'zh-CN');
    const state = createI18nState(window.localStorage);

    expect(state.locale.value).toBe('zh-CN');
    expect(state.t('gallery.entryCount', { count: 2 })).toBe('2 个条目');

    state.setLocale('en');
    expect(window.localStorage.getItem('t3.locale')).toBe('en');
  });
});
