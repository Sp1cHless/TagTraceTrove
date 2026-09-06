import { ref, type Ref } from 'vue';

/**
 * "Click before dialog": a destructive action arms on the first click — the
 * button itself switches to its confirm copy — and runs on the second click.
 * Arming expires automatically, so no global listeners are needed.
 */
export function useArmableAction(timeoutMs = 4000): {
  armedKey: Readonly<Ref<string | null>>;
  /** Returns true when the action should run now, false when just armed. */
  arm: (key: string) => boolean;
  disarm: (key?: string) => void;
} {
  const armedKey = ref<string | null>(null);
  let timer: number | null = null;

  function arm(key: string): boolean {
    if (armedKey.value === key) {
      disarm();
      return true;
    }
    armedKey.value = key;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      armedKey.value = null;
      timer = null;
    }, timeoutMs);
    return false;
  }

  function disarm(key?: string): void {
    if (key === undefined || armedKey.value === key) {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      armedKey.value = null;
    }
  }

  return { armedKey, arm, disarm };
}
