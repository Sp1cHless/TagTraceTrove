// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import type { RelationSuggestion } from '@t3/shared';
import SuggestionInput from '../src/components/SuggestionInput.vue';

type Deferred = {
  promise: Promise<RelationSuggestion[]>;
  resolve: (value: RelationSuggestion[]) => void;
  reject: (cause: unknown) => void;
};

function makeSuggestion(
  id: number,
  name: string,
  matchedAlias?: string,
): RelationSuggestion {
  return {
    id,
    name,
    ...(matchedAlias === undefined ? {} : { matchedAlias }),
    sameContextUsageCount: 0,
    totalUsageCount: 0,
  };
}

function defer(): Deferred {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<RelationSuggestion[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Real timers throughout: fake timers interact badly with promise continuations
// that are created inside the debounced fetch. The debounce is injected short
// so each test only waits a few tens of milliseconds; the shipped default
// stays 150ms.
const TEST_DEBOUNCE_MS = 20;
const SEARCH_SETTLE_MS = TEST_DEBOUNCE_MS + 60;
const APPLY_MS = 40;

type HarnessProps = {
  mode?: 'creatable-text' | 'id-only';
  excludeIds?: number[];
  commitOnBlur?: boolean;
  selectFillsInput?: boolean;
};

/** The device measurement the phone layout is built on: the soft keyboard
 * shrinks window.innerHeight to 430 while the author field's bottom sits at
 * 407, so a downward list lands under the keyboard. */
function stubPlacement(
  element: Element,
  rect: { top: number; bottom: number },
  viewportHeight: number,
): void {
  (element as HTMLElement).getBoundingClientRect = () => ({
    top: rect.top, bottom: rect.bottom, left: 0, right: 0,
    width: 200, height: rect.bottom - rect.top, x: 0, y: rect.top,
    toJSON: () => ({}),
  }) as DOMRect;
  Object.defineProperty(window, 'innerHeight', {
    value: viewportHeight, configurable: true, writable: true,
  });
}

async function mountHarness(props: HarnessProps = {}) {
  const calls: Array<{ query: string; excludeIds: number[] }> = [];
  const pending: Deferred[] = [];
  const provider = (
    query: string,
    excludeIds: number[],
  ): Promise<RelationSuggestion[]> => {
    calls.push({ query, excludeIds });
    const deferred = defer();
    pending.push(deferred);
    return deferred.promise;
  };
  const Harness = defineComponent({
    components: { SuggestionInput },
    props: {
      mode: { type: String, default: props.mode ?? 'creatable-text' },
      excludeIds: { type: Array<number>, default: () => props.excludeIds ?? [] },
      commitOnBlur: { type: Boolean, default: props.commitOnBlur ?? false },
      selectFillsInput: { type: Boolean, default: props.selectFillsInput ?? false },
    },
    emits: ['select', 'submit-text'],
    setup() {
      return { provider, debounceMs: TEST_DEBOUNCE_MS };
    },
    template: `
      <SuggestionInput
        :mode="mode"
        :provider="provider"
        :exclude-ids="excludeIds"
        :commit-on-blur="commitOnBlur"
        :select-fills-input="selectFillsInput"
        :debounce-ms="debounceMs"
        placeholder="Relation"
        @select="$emit('select', $event)"
        @submit-text="$emit('submit-text', $event)"
      />
    `,
  });
  const wrapper = mount(Harness);
  const input = wrapper.find('input');
  // A real user has clicked into the field before typing; jsdom does not
  // focus elements on setValue.
  await input.trigger('focus');
  return { wrapper, input, calls, pending };
}

async function typeAndSettle(
  input: { setValue: (value: string) => Promise<void> },
  text: string,
): Promise<void> {
  await input.setValue(text);
  await sleep(SEARCH_SETTLE_MS);
}

describe('SuggestionInput', () => {
  it('does not call the provider for blank or whitespace-only queries', async () => {
    const { wrapper, input, calls } = await mountHarness();
    await typeAndSettle(input, '  ');
    expect(calls).toEqual([]);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
  });

  // The debounce contract is a timing *upper* bound, and a real-timer sleep is
  // only a lower bound (a loaded machine overshoots it), so this one assertion
  // drives the clock instead of racing it.
  it('waits out the debounce before searching for a single character', async () => {
    vi.useFakeTimers();
    try {
      const { input, calls } = await mountHarness();
      await input.setValue('校');
      await vi.advanceTimersByTimeAsync(TEST_DEBOUNCE_MS - 1);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(calls).toEqual([{ query: '校', excludeIds: [] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the returned candidates for a single character', async () => {
    const { wrapper, input, calls, pending } = await mountHarness();
    await typeAndSettle(input, '校');
    expect(calls).toEqual([{ query: '校', excludeIds: [] }]);
    pending[0]!.resolve([
      makeSuggestion(1, '校园'),
      makeSuggestion(2, '学校'),
    ]);
    await sleep(APPLY_MS);
    const options = wrapper.findAll('[role="option"]');
    expect(options.map((option) => option.text())).toEqual(['校园', '学校']);
  });

  it('passes excludeIds to the provider and refetches when they change', async () => {
    const { wrapper, input, calls, pending } = await mountHarness({ excludeIds: [7] });
    await typeAndSettle(input, '校');
    expect(calls[0]!.excludeIds).toEqual([7]);
    pending[0]!.resolve([makeSuggestion(1, '校园')]);
    await sleep(APPLY_MS);
    await wrapper.setProps({ excludeIds: [7, 9] });
    await sleep(SEARCH_SETTLE_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.excludeIds).toEqual([7, 9]);
  });

  it('discards stale responses and keeps the newest query results', async () => {
    const { wrapper, input, calls, pending } = await mountHarness();
    await typeAndSettle(input, '校');
    await typeAndSettle(input, '校园');
    expect(calls).toHaveLength(2);
    pending[0]!.resolve([makeSuggestion(1, '校服')]);
    await sleep(APPLY_MS);
    pending[1]!.resolve([makeSuggestion(2, '校园生活')]);
    await sleep(APPLY_MS);
    const options = wrapper.findAll('[role="option"]');
    expect(options.map((option) => option.text())).toEqual(['校园生活']);
  });

  it('selects a candidate on click and does not submit the raw text', async () => {
    const { wrapper, input, pending } = await mountHarness();
    await typeAndSettle(input, '校');
    pending[0]!.resolve([
      makeSuggestion(1, '校园'),
      makeSuggestion(5, '学校', 'school'),
    ]);
    await sleep(APPLY_MS);
    const options = wrapper.findAll('[role="option"] button');
    await options[1]!.trigger('mousedown');
    await options[1]!.trigger('click');
    expect(wrapper.emitted('select')).toEqual([[
      { id: 5, name: '学校', matchedAlias: 'school', sameContextUsageCount: 0, totalUsageCount: 0 },
    ]]);
    expect(wrapper.emitted('submit-text')).toBeUndefined();
  });

  it('submits the typed text on Enter only when nothing is highlighted (creatable mode)', async () => {
    const { wrapper, input, pending } = await mountHarness();
    await typeAndSettle(input, '校园');
    pending[0]!.resolve([makeSuggestion(1, '校园生活')]);
    await sleep(APPLY_MS);
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('submit-text')).toEqual([['校园']]);

    await typeAndSettle(input, '全新标签');
    pending[1]!.resolve([makeSuggestion(3, '校园生活')]);
    await sleep(APPLY_MS);
    await input.trigger('keydown.down');
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('select')).toEqual([[
      { id: 3, name: '校园生活', sameContextUsageCount: 0, totalUsageCount: 0 },
    ]]);
    expect(wrapper.emitted('submit-text')).toHaveLength(1);
  });

  it('never submits text on Enter in id-only mode', async () => {
    const { wrapper, input } = await mountHarness({ mode: 'id-only' });
    await typeAndSettle(input, '青');
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('submit-text')).toBeUndefined();
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('selects an exact match on Enter in id-only mode (typing the full name links it)', async () => {
    const { wrapper, input, pending } = await mountHarness({ mode: 'id-only' });
    await typeAndSettle(input, 'yuki');
    pending[0]!.resolve([makeSuggestion(4, 'yuki'), makeSuggestion(5, 'yukino')]);
    await sleep(APPLY_MS);
    // 没有任何高亮,但输入与候选完全一致 -> 直接选中
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('select')).toEqual([[{
      id: 4, name: 'yuki', sameContextUsageCount: 0, totalUsageCount: 0,
    }]]);
    expect(wrapper.emitted('submit-text')).toBeUndefined();
  });

  it('does not select on Enter in id-only mode when nothing matches exactly', async () => {
    const { wrapper, input, pending } = await mountHarness({ mode: 'id-only' });
    await typeAndSettle(input, 'yuki');
    pending[0]!.resolve([makeSuggestion(5, 'yukino')]);
    await sleep(APPLY_MS);
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.emitted('submit-text')).toBeUndefined();
  });

  it('resolves an exact match on blur in id-only mode (type the name and click away)', async () => {
    const { wrapper, input, pending } = await mountHarness({ mode: 'id-only' });
    await typeAndSettle(input, 'yuki');
    pending[0]!.resolve([makeSuggestion(4, 'yuki'), makeSuggestion(5, 'yukino')]);
    await sleep(APPLY_MS);
    await input.trigger('blur');
    expect(wrapper.emitted('select')).toEqual([[{
      id: 4, name: 'yuki', sameContextUsageCount: 0, totalUsageCount: 0,
    }]]);
    expect(wrapper.emitted('submit-text')).toBeUndefined();
  });

  it('does not resolve on blur when the typed text is not an exact match', async () => {
    const { wrapper, input, pending } = await mountHarness({ mode: 'id-only' });
    await typeAndSettle(input, 'yuk');
    pending[0]!.resolve([makeSuggestion(5, 'yukino')]);
    await sleep(APPLY_MS);
    await input.trigger('blur');
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('selects on Enter through a matched alias in id-only mode', async () => {
    const { wrapper, input, pending } = await mountHarness({ mode: 'id-only' });
    await typeAndSettle(input, 'yuki');
    pending[0]!.resolve([makeSuggestion(7, '雪', 'yuki')]);
    await sleep(APPLY_MS);
    await input.trigger('keydown.enter');
    expect(wrapper.emitted('select')).toEqual([[{
      id: 7, name: '雪', matchedAlias: 'yuki', sameContextUsageCount: 0, totalUsageCount: 0,
    }]]);
  });

  it('moves the highlight with arrows without wrapping past the ends', async () => {
    const { wrapper, input, pending } = await mountHarness({ mode: 'id-only' });
    await typeAndSettle(input, '校');
    pending[0]!.resolve([makeSuggestion(1, '校园'), makeSuggestion(2, '学校')]);
    await sleep(APPLY_MS);
    await input.trigger('keydown.up');
    expect(wrapper.find('[role="combobox"]').attributes('aria-activedescendant')).toBeUndefined();
    await input.trigger('keydown.down');
    await input.trigger('keydown.down');
    await input.trigger('keydown.down');
    const options = wrapper.findAll('[role="option"] button');
    expect(options[1]!.classes()).toContain('suggestion-input__option--highlighted');
    expect(options[0]!.classes()).not.toContain('suggestion-input__option--highlighted');
  });

  it('closes on Escape without clearing the input and without submitting', async () => {
    const { wrapper, input, pending } = await mountHarness();
    await typeAndSettle(input, '校园');
    pending[0]!.resolve([makeSuggestion(1, '校园生活')]);
    await sleep(APPLY_MS);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
    await input.trigger('keydown.esc');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect((input.element as HTMLInputElement).value).toBe('校园');
    expect(wrapper.emitted('submit-text')).toBeUndefined();
  });

  it('closes on blur without submitting or linking', async () => {
    const { wrapper, input, pending } = await mountHarness();
    await typeAndSettle(input, '校园');
    pending[0]!.resolve([makeSuggestion(1, '校园生活')]);
    await sleep(APPLY_MS);
    await input.trigger('blur');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.emitted('submit-text')).toBeUndefined();
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('commits the typed text on blur when commit-on-blur is enabled', async () => {
    const { wrapper, input, pending } = await mountHarness({ commitOnBlur: true });
    await typeAndSettle(input, '女仆');
    pending[0]!.resolve([makeSuggestion(1, '女仆')]);
    await sleep(APPLY_MS);
    await input.trigger('blur');
    expect(wrapper.emitted('submit-text')).toEqual([['女仆']]);
    // The editor resets, ready for the next tag.
    expect((input.element as HTMLInputElement).value).toBe('');

    // Leaving it empty and clicking away just closes without a submit.
    await input.trigger('focus');
    await input.setValue('  ');
    await input.trigger('blur');
    expect(wrapper.emitted('submit-text')).toHaveLength(1);
  });

  it('keeps the typed text in fill-in editors after the blur commit', async () => {
    // The alias/merge forms treat the field as the visible record of the value
    // they save, so a blur commit must not wipe what the user typed.
    const { wrapper, input, pending } = await mountHarness({ commitOnBlur: true, selectFillsInput: true });
    await typeAndSettle(input, '雪');
    pending[0]!.resolve([]);
    await sleep(APPLY_MS);
    await input.trigger('blur');
    expect(wrapper.emitted('submit-text')).toEqual([['雪']]);
    expect((input.element as HTMLInputElement).value).toBe('雪');

    // Focusing again and typing more keeps committing the current text.
    await input.trigger('focus');
    await input.setValue('雪绪');
    await input.trigger('blur');
    expect(wrapper.emitted('submit-text')).toEqual([['雪'], ['雪绪']]);
    expect((input.element as HTMLInputElement).value).toBe('雪绪');

    // Emptying the field clears the value it stands for.
    await input.trigger('focus');
    await input.setValue('');
    await input.trigger('blur');
    expect(wrapper.emitted('submit-text')).toEqual([['雪'], ['雪绪'], ['']]);
  });

  it('never commits on blur in id-only mode even with commit-on-blur', async () => {
    const { wrapper, input } = await mountHarness({ mode: 'id-only', commitOnBlur: true });
    await typeAndSettle(input, '青');
    await input.trigger('blur');
    expect(wrapper.emitted('submit-text')).toBeUndefined();
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('fills the input with the chosen name in select-fills mode (merge/alias forms)', async () => {
    const { wrapper, input, pending } = await mountHarness({ selectFillsInput: true });
    await typeAndSettle(input, 'kaise');
    pending[0]!.resolve([makeSuggestion(1, 'kaise_dake'), makeSuggestion(2, 'kaise dake')]);
    await sleep(APPLY_MS);
    const options = wrapper.findAll('[role="option"] button');
    await options[0]!.trigger('click');
    // The chosen name fills the field; the parent records it via `select`.
    expect((input.element as HTMLInputElement).value).toBe('kaise_dake');
    expect(wrapper.emitted('select')).toEqual([[
      { id: 1, name: 'kaise_dake', sameContextUsageCount: 0, totalUsageCount: 0 },
    ]]);
    // Continue typing reopens the dropdown for the next candidate.
    await input.setValue('kaise d');
    await sleep(SEARCH_SETTLE_MS);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
  });

  it('keeps the input short and growing with the typed text', async () => {
    const { input } = await mountHarness();
    expect(input.attributes('size')).toBe('5');
    await input.setValue('女');
    expect(input.attributes('size')).toBe('5');
    await input.setValue('女仆学园大战争');
    expect(input.attributes('size')).toBe('7');
  });

  it('requests candidates during IME composition but never submits its text', async () => {
    const { wrapper, input, calls } = await mountHarness();
    await input.trigger('compositionstart');
    await input.setValue('青');
    await sleep(SEARCH_SETTLE_MS);
    // A phone's keyboard can hold plain letters inside a composition span:
    // the candidates must still follow the text, or nothing shows until the
    // field loses focus.
    expect(calls).toEqual([{ query: '青', excludeIds: [] }]);
    // A key the IME itself is part of carries `isComposing`; that is what the
    // component must honour, not a flag that may never be cleared.
    const duringComposition = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(duringComposition, 'isComposing', { value: true });
    input.element.dispatchEvent(duringComposition);
    expect(wrapper.emitted('submit-text')).toBeUndefined();
    await input.trigger('compositionend');
    await sleep(SEARCH_SETTLE_MS);
    expect(calls).toEqual([{ query: '青', excludeIds: [] }]);
  });

  // Vue's own v-model listener drops `input` events while an IME composition is
  // open (`e.target.composing`) — measured on the device: the component's query
  // stayed at the previous value through a whole composition, so no search ever
  // ran and the candidates only surfaced once the composition committed, which
  // the user reads as "nothing happens until I tap away".
  it('follows the text the field shows while an IME composition is still open', async () => {
    const { input, calls } = await mountHarness();
    await input.trigger('compositionstart');
    const element = input.element as HTMLInputElement;
    element.value = 'abcdefgh';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(SEARCH_SETTLE_MS);
    expect(element.getAttribute('size')).toBe('8');
    expect(calls).toEqual([{ query: 'abcdefgh', excludeIds: [] }]);
  });

  // Measured on the phone: the tag editor committed nothing on Enter and the
  // tag only appeared once the field lost focus (the user's "it shows up after
  // I press Done"). The component's own composition flag was left set because a
  // phone keyboard can hold a composition open for a whole typing session, and
  // onEnter trusted that flag instead of the event's own `isComposing`.
  it('commits on Enter once the composition has ended, even if the flag was left set', async () => {
    const { input, wrapper } = await mountHarness();
    await input.trigger('compositionstart');
    const element = input.element as HTMLInputElement;
    element.value = 'zztmp';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(SEARCH_SETTLE_MS);
    // A real Enter that the IME is not part of: the composition has ended by
    // the time this key event is dispatched.
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    await sleep(APPLY_MS);
    expect(wrapper.emitted('submit-text')).toEqual([['zztmp']]);
  });

  it('leaves Enter to the IME while a composition is really in progress', async () => {
    const { input, wrapper } = await mountHarness();
    await input.trigger('compositionstart');
    const element = input.element as HTMLInputElement;
    element.value = 'zhongwen';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(SEARCH_SETTLE_MS);
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'isComposing', { value: true });
    element.dispatchEvent(event);
    await sleep(APPLY_MS);
    expect(wrapper.emitted('submit-text')).toBeUndefined();
  });

  it('shows the empty state once a live query returns no candidates', async () => {
    const { wrapper, input, pending } = await mountHarness();
    await typeAndSettle(input, '不存在');
    pending[0]!.resolve([]);
    await sleep(APPLY_MS);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
    expect(wrapper.find('.suggestion-input__empty').exists()).toBe(true);
  });

  it('flips the candidate list above the field when the keyboard leaves no room below', async () => {
    const { wrapper, input, pending } = await mountHarness();
    stubPlacement(input.element, { top: 377, bottom: 407 }, 430);
    await typeAndSettle(input, 'a');
    pending[0]!.resolve([makeSuggestion(1, 'A1'), makeSuggestion(2, 'A2')]);
    await sleep(APPLY_MS);
    const list = wrapper.find('[role="listbox"]');
    expect(list.exists()).toBe(true);
    expect(list.classes()).toContain('suggestion-input__list--up');
    // 377px of room above minus the 8px gap, so the full 224px list fits.
    expect(list.attributes('style')).toContain('max-height: 224px');
  });

  it('keeps opening downward on a viewport with room below the field', async () => {
    const { wrapper, input, pending } = await mountHarness();
    stubPlacement(input.element, { top: 280, bottom: 310 }, 800);
    await typeAndSettle(input, 'a');
    pending[0]!.resolve([makeSuggestion(1, 'A1')]);
    await sleep(APPLY_MS);
    const list = wrapper.find('[role="listbox"]');
    expect(list.classes()).not.toContain('suggestion-input__list--up');
    expect(list.attributes('style')).toContain('max-height: 224px');
  });

  it('shrinks the list to the room left below a field in the middle of a keyboard-shrunk viewport', async () => {
    const { wrapper, input, pending } = await mountHarness();
    // 120px below (roomier than the 40px above, so it still opens downward)
    // would clip a 224px list: the list is bounded to what fits.
    stubPlacement(input.element, { top: 240, bottom: 270 }, 430);
    await typeAndSettle(input, 'a');
    pending[0]!.resolve([makeSuggestion(1, 'A1')]);
    await sleep(APPLY_MS);
    const list = wrapper.find('[role="listbox"]');
    expect(list.classes()).not.toContain('suggestion-input__list--up');
    expect(list.attributes('style')).toContain('max-height: 152px');
  });

  it('survives a rejected provider call without throwing', async () => {
    const { wrapper, input, pending } = await mountHarness();
    await typeAndSettle(input, '校');
    pending[0]!.reject(new Error('network down'));
    await sleep(APPLY_MS);
    expect(wrapper.find('[role="option"]').exists()).toBe(false);
  });
});
