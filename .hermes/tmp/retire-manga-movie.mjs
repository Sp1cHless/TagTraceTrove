// Retire the two leftover Galleries through the app's own section delete (facets cascade).
// manga: sections 1, 5   movie: sections 8, 138   — both types have 0 entries and 0 tag assignments.
const base = 'http://127.0.0.1:8765/api';

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  return `${method} ${path} → ${response.status} ${(await response.text()).slice(0, 160)}`;
}

const sections = { manga: [1, 5], movie: [8, 138] };

for (const [type, ids] of Object.entries(sections)) {
  for (const id of ids) console.log(await call('DELETE', `/sections/${id}`));
  console.log('layout left:', (await call('GET', `/layouts/${encodeURIComponent(type)}`)).slice(0, 120));
}

const templates = await (await fetch(`${base}/templates`)).json();
const list = templates.templates ?? templates;
console.log('\nentryTypes now:', list.map((entry) => entry.entryType).join(', '));
for (const name of ['manga', 'movie']) {
  console.log(`${name} still listed:`, list.some((entry) => entry.entryType === name));
}
