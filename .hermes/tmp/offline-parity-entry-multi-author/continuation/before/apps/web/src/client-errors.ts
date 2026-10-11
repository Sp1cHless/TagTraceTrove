/**
 * The last few things that went wrong on this page.
 *
 * The System page is where someone goes when something is broken, and by then the console has
 * usually scrolled away. This keeps a small ring of uncaught errors, unhandled rejections and
 * explicit `console.error` lines so they can be read and copied from the page itself. It is
 * installed once at startup and never throws: a diagnostics aid that can break the app would be
 * worse than no diagnostics at all.
 */

export interface CapturedClientError {
  at: string;
  kind: 'error' | 'rejection' | 'console';
  message: string;
  source: string | null;
}

const LIMIT = 40;
const captured: CapturedClientError[] = [];
let installed = false;

function record(kind: CapturedClientError['kind'], message: string, source: string | null): void {
  captured.push({ at: new Date().toISOString(), kind, message: message.slice(0, 2000), source });
  if (captured.length > LIMIT) {
    captured.splice(0, captured.length - LIMIT);
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function installClientErrorCapture(target: Window = window): void {
  if (installed) {
    return;
  }
  installed = true;
  target.addEventListener('error', (event) => {
    const detail = event as ErrorEvent;
    record('error', detail.error === undefined ? String(detail.message) : describe(detail.error), detail.filename ?? null);
  });
  target.addEventListener('unhandledrejection', (event) => {
    record('rejection', describe((event as PromiseRejectionEvent).reason), null);
  });
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    record('console', args.map((value) => describe(value)).join(' '), null);
    original(...args);
  };
}

export function clientErrors(): CapturedClientError[] {
  return [...captured];
}

/** For tests and for a person who wants a clean slate before reproducing something. */
export function clearClientErrors(): void {
  captured.length = 0;
}
