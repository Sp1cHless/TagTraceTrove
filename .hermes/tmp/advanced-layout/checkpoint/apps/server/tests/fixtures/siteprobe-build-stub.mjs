#!/usr/bin/env node
/* global process */
/* A stand-in for build_adapter.py: the same console shape, human-time waits. */
import { existsSync } from 'node:fs';

const newline = String.fromCharCode(10);

/**
 * Python block-buffers a *piped* stdout unless `PYTHONUNBUFFERED` is set, so the sentences a
 * person is waiting for — the annotation page's address, "opening the page" — sit in the buffer
 * while the process waits on that person. Measured in the app on 2026-10-03: the page was served,
 * T³'s status stayed at "preparing", and the log held one line. Modelled here, because that is
 * what makes the transport's environment something a test can fail on.
 */
const buffered = process.env.PYTHONUNBUFFERED !== '1';
const held = [];
function say(line) {
  if (buffered) held.push(line);
  else process.stdout.write(`${line}${newline}`);
}
function flush() {
  if (held.length > 0) process.stdout.write(`${held.join(newline)}${newline}`);
}

const urls = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const marker = process.env.BUILD_MARKER ?? '';
// The builder's two endings besides "installed": its own refusal (exit 1, everything it has to
// say on stdout) and a crash (a traceback on stderr). The panel has to tell them apart — one is
// 过于复杂, the other is a bug report.
if (process.env.BUILD_REFUSE === '1') {
  say('=== does the draft read what the runtime reads');
  say('PASS — 4/4 field(s) agree');
  say(`[STOP] no target of this draft matches '${urls[0] ?? ''}'`);
  say('nothing was installed: a target that cannot name its own address would be invisible.');
  flush();
  process.exit(1);
}
if (process.env.BUILD_CRASH === '1') {
  process.stderr.write(`Traceback (most recent call last):${newline}`);
  process.stderr.write(`  File "build_adapter.py", line 1, in <module>${newline}`);
  process.stderr.write(`ValueError: the harvest is empty${newline}`);
  process.exit(1);
}
// What T³ handed the tool that the tool cannot know for itself, printed so a test can read it.
say(`    language: ${process.env.SITEPROBE_LANG ?? ''}`);
// A listing build is the *other* builder (`build_listing.py`), and its `--kind` is the flag that
// says which listing is being learned: `build_adapter.py` has no such flag, so a kind arriving here
// is proof the transport chose the listing door.
say(`    kind: ${process.argv.find((arg) => arg.startsWith('--kind=')) ?? ''}`);
for (const url of urls) {
  say(`    capturing ${url} with a headless browser; this can take up to a minute`);
  say(`    annotation page: http://127.0.0.1:45555/?token=stub`);
  say(`    opening the page (annotate); submit it to continue`);
  if (marker) {
    const deadline = Date.now() + 30000;
    while (!existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (!existsSync(marker)) {
      process.stderr.write(`the annotation was never submitted${newline}`);
      flush();
      process.exit(1);
    }
  }
}
say(`=== installed ${process.env.BUILD_HOME ?? '/home'}/local/built.test`);
flush();
process.exit(0);
