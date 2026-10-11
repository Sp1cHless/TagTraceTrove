#!/usr/bin/env node
/* global process, setInterval, Buffer */
/**
 * A stand-in for the Python tool, for tests that must not need a virtualenv or a network.
 *
 * It speaks the same contract on stdout (`siteprobe/src/generic/integration.py`) for the four
 * commands, and it can misbehave on purpose — the two faults that matter are a line that is not part
 * of the contract (`garbage`) and a run that never ends (`slow`), because a caller must notice both
 * rather than hang or read undefined fields.
 *
 * Run through the real transport by pointing the tooling at it:
 *   { python: process.execPath, pythonArgs: [thisFile] }
 */
function main() {
const args = process.argv.slice(2);
const command = args[0];

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// The Level 0 door (`fetch_work_meta.py <url>`): called with a URL, it answers in the reader's own
// vocabulary. `demo.test/ok` is readable; everything else is the class that needs a rule.
if (/^https?:/u.test(command)) {
  const url = command;
  if (url.includes('/garbage')) {
    // Not JSON at all: what a crashing reader looks like from this side.
    process.stdout.write('Traceback (most recent call last):' + String.fromCharCode(10));
    process.stderr.write('ValueError: something in the reader broke' + String.fromCharCode(10));
    process.exit(1);
  }
  if (url.includes('/not-a-url')) {
    emit({ input_url: url, source_url: null, outcome: 'bad-input', kind: 'invalid',
           detail: 'not an http(s) URL', title: null, cover: null, export: null });
    process.exit(0);
  }
  const writable = url.includes('/ok');
  // A four-byte JPEG, base64: what the real reader puts here is whatever it downloaded.
  const cover = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  emit({
    input_url: url,
    source_url: writable ? url : null,
    outcome: writable ? 'ok' : 'no-title',
    kind: writable ? 'found' : 'teaching',
    detail: writable ? 'title and cover read' : 'no title among the candidates',
    title: writable ? 'A fetched title' : null,
    cover: null,
    cover_base64: writable ? cover : null,
    cover_mime: writable ? 'image/jpeg' : null,
    cover_bytes: writable ? 4 : null,
  });
  process.exit(0);
}

if (command === 'sites') {
  emit({
    event: 'sites',
    home: process.env.SITEPROBE_HOME ?? '',
    sites: [
      {
        key: 'demo.test',
        display_name: 'Demo',
        export_group: 'demo_test',
        hosts: ['demo.test'],
        targets: [
          { kind: 'work', label: 'Work', single: true, accepts_name: false, source: 'installed' },
          { kind: 'search', label: 'Search', single: false, accepts_name: true, source: 'installed' },
        ],
        adapters: [{ source: 'installed', reads: ['work', 'search'], readme: true }],
      },
    ],
  });
  process.exit(0);
}

if (command === 'resolve') {
  const input = args[1] ?? '';
  if (input.includes('demo.test')) {
    emit({
      event: 'resolve', matched: true, input, site: 'demo.test', display_name: 'Demo',
      export_group: 'demo_test', source: 'installed', kind: 'work', label: 'Work', single: true,
      ref: { id: '42' },
    });
    process.exit(0);
  }
  emit({
    event: 'resolve', matched: false, input, reason: 'NO_MATCH',
    detail: `no site claims '${input}'. Known sites: demo.test`,
  });
  process.exit(2);
}

if (command === 'readme') {
  const site = args[args.indexOf('--site') + 1] ?? '';
  if (site !== 'demo.test') {
    emit({ event: 'error', command: 'readme', code: 'UNKNOWN_SITE',
           message: `unknown site '${site}'` });
    process.exit(2);
  }
  emit({ event: 'readme', site, source: 'installed',
         text: ['# Demo', '', 'What it covers: everything the tests need.', '']
           .join(String.fromCharCode(10)) });
  process.exit(0);
}

if (command === 'run' || command === 'selection') {
  const input = args[1] ?? '';
  if (input === 'garbage') {
    process.stdout.write('this line is not part of the contract\n');
    process.exit(0);
  }
  if (input === 'slow') {
    setInterval(() => {}, 1000);
    return;
  }
  if (input === 'crash') {
    // What an unhandled exception in the tool looks like from this side: a traceback on stderr.
    const newline = String.fromCharCode(10);
    process.stderr.write(['Traceback (most recent call last):',
                          '  File "integration.py", line 16, in <module>',
                          'SSLError: Connection closed abruptly', ''].join(newline));
    process.exit(1);
  }
  if (input === 'boom') {
    emit({ event: 'error', command: 'run', code: 'RUN_FAILED', message: 'the site refused' });
    process.exit(1);
  }

  emit({ event: 'progress', message: `site: demo.test kind: work` });
  const listing = `${process.env.SITEPROBE_HOME ?? ''}/export/demo_test/listing_x`;
  if (args.includes('--review')) {
    emit({
      event: 'review', site: 'demo.test', kind: 'search', ref: 'x', listing,
      review_html: `${listing}/review.html`, summary: { cards: 2 }, count: 2, warnings: [],
    });
    emit({
      event: 'result', command: 'run', site: 'demo.test', kind: 'search', ref: 'x', works: null,
      listing, export: null, review_html: `${listing}/review.html`, origin: null, media: {},
      warnings: [],
    });
    process.exit(0);
  }
  emit({
    event: 'result',
    command: command === 'selection' ? 'selection' : 'run',
    site: 'demo.test',
    kind: 'search',
    ref: 'x',
    works: 2,
    listing,
    export: `${listing}/metadata.json`,
    review_html: null,
    origin: { kind: 'search', ref: 'x' },
    media: { cover: 2 },
    warnings: [],
    ...(command === 'selection' ? { selection: input } : {}),
  });
  process.exit(0);
}

process.stderr.write(`unknown command: ${command ?? '(none)'}\n`);
process.exit(2);
}

main();
