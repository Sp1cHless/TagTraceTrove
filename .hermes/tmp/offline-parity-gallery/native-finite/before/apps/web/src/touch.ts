/** Small screen- and input-kind helpers, so a component never guesses at either. */

/**
 * Whether the device has no hover — no mouse, no double-click, no drag.
 *
 * Measured rather than sniffed from a user agent: a touch screen is a touch screen whether it is a
 * phone, a tablet or a laptop with a digitiser, and what a component needs to know is which
 * *interactions* are available, not what the browser calls itself. Used for two things so far: the
 * hint that tells a person how to move a Tag, and opening the page-count/date editors on a tap
 * (there is no double-click literal on a touch screen).
 */
export function touchOnlyDevice(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: none)').matches;
}
