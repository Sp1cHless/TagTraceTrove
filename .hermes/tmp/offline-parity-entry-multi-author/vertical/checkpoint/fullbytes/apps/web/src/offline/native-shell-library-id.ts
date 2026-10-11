export interface ShellLibraryIdBridge {
  /** Absent outside the shell, or on a bridge that predates this plugin. */
  nativePromise?(plugin: string, method: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ShellLibraryIdSource {
  /** The paired library identity, or null when this build is not the shell or
   * the shell cannot answer. */
  read(): Promise<string | null>;
  /** Forget the remembered identity: pairing can change while the page is hidden. */
  invalidate(): void;
}

/**
 * The shell's paired library identity, read once and remembered.
 *
 * Every offline read asks whether the saved copy still belongs to the paired
 * library. That answer used to cost a native bridge call per read — and while a
 * stalled transport request occupied the plugin worker it took seconds, which
 * is what made opening an Entry wait. v40 moved the call off the request worker;
 * this removes the per-read call altogether. Only a real answer is remembered:
 * a failed read is retried, so the guard can never silently pass on an unknown
 * identity.
 */
export function createShellLibraryIdSource(options: {
  bridge: ShellLibraryIdBridge | undefined;
  isNativeShell: () => boolean;
}): ShellLibraryIdSource {
  let remembered: string | null = null;
  let inFlight: Promise<string | null> | null = null;

  const readFromBridge = async (): Promise<string | null> => {
    const bridge = options.bridge;
    if (bridge === undefined || bridge.nativePromise === undefined || !options.isNativeShell()) return null;
    try {
      const status = await bridge.nativePromise('T3PairedTransport', 'status', {});
      const paired = status as { paired?: boolean; libraryId?: string };
      return paired?.paired === true && typeof paired.libraryId === 'string' ? paired.libraryId : null;
    } catch {
      // An unreadable pairing is not an answer: do not remember it.
      return null;
    }
  };

  return {
    read(): Promise<string | null> {
      if (remembered !== null) return Promise.resolve(remembered);
      inFlight ??= readFromBridge()
        .then((value) => {
          if (value !== null) remembered = value;
          return value;
        })
        .finally(() => { inFlight = null; });
      return inFlight;
    },
    invalidate(): void {
      remembered = null;
    },
  };
}
