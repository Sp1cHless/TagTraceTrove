// The two hand adjustments the user asked for, through the app's own HTTP routes:
//   1. give `小说` the common template's General Rating (it was built before the template carried it);
//   2. retire the scratch Gallery `template专用` (0 entries; its content is now the repo's common template).
// Node's fetch sends the JSON body as UTF-8, so the entry type survives the trip.
const base = 'http://127.0.0.1:8765/api';

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  return { status: response.status, text };
}

console.log('--- before ---');
console.log('templates:', (await call('GET', '/templates')).text.slice(0, 400));
console.log('小说 slots:', (await call('GET', `/rating-slots?entryType=${encodeURIComponent('小说')}`)).text);

console.log('\n--- 1. back-fill 小说 ---');
console.log(await call('POST', '/templates/common/rating-slots/apply', { entryType: '小说' }));
console.log('小说 slots:', (await call('GET', `/rating-slots?entryType=${encodeURIComponent('小说')}`)).text);

console.log('\n--- 2. retire 模板专用 (sections 170 and 175) ---');
for (const sectionId of [170, 175]) {
  console.log(`delete section ${sectionId}:`, await call('DELETE', `/sections/${sectionId}`));
}

console.log('\n--- after ---');
console.log('templates:', (await call('GET', '/templates')).text.slice(0, 500));
console.log('galleries:', (await call('GET', '/galleries')).text.slice(0, 300));
console.log('layout 模板专用:', (await call('GET', `/layouts/${encodeURIComponent('模板专用')}`)).text);
console.log('layout 小说:', (await call('GET', `/layouts/${encodeURIComponent('小说')}`)).text);
