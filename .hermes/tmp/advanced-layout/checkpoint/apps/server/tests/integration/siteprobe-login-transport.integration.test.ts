import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { startSiteprobeLogin, LOGIN_BAT } from '../../src/siteprobe/transport.js';

let directory: string | undefined;
afterEach(async () => {
  spawn.mockReset();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('does not emit an unhandled stdin error when finishing a closed login door', async () => {
  directory = await mkdtemp(join(tmpdir(), 'siteprobe-login-'));
  await writeFile(join(directory, LOGIN_BAT), '');
  const stdin = new EventEmitter() as EventEmitter & { write: (text: string) => boolean };
  stdin.write = () => {
    stdin.emit('error', new Error('EPIPE'));
    return false;
  };
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout: new PassThrough(), stderr: new PassThrough(),
  });
  spawn.mockReturnValue(child);
  const login = startSiteprobeLogin({
    ok: true, detail: null, tool: directory, home: directory,
    python: '', pythonArgs: [], linkArgs: [], buildArgs: [], listingArgs: [],
  }, 'https://example.test');
  expect(() => login.finish()).not.toThrow();
  child.emit('close', 1);
  await expect(login.done).resolves.toMatchObject({ code: 1 });
});
