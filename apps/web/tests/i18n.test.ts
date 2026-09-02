// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createI18nState, messages } from '../src/i18n.js';

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
