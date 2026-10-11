const r = await fetch('http://127.0.0.1:9222/json/list').then((x) => x.json());
const page = r.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0;
const send = (method, params) => new Promise((res) => {
  const mine = ++id;
  const onMessage = (e) => { const d = JSON.parse(e.data); if (d.id === mine) { ws.removeEventListener('message', onMessage); res(d.result); } };
  ws.addEventListener('message', onMessage);
  ws.send(JSON.stringify({ id: mine, method, params }));
});
const expression = `(async () => {
  const names = await caches.keys();
  let entries = 0;
  for (const n of names) if (n.startsWith("t3-offline-media-v1")) entries += (await (await caches.open(n)).keys()).length;
  return JSON.stringify({ t: Date.now(), entries });
})()`;
const samples = [];
const rounds = Number(process.argv[2] ?? 7);
for (let round = 0; round < rounds; round += 1) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
  const value = JSON.parse(out.result.value);
  samples.push(value);
  console.log(JSON.stringify(value));
  if (round < rounds - 1) await new Promise((res) => setTimeout(res, 30000));
}
const first = samples[0]; const last = samples[samples.length - 1];
const seconds = (last.t - first.t) / 1000;
const images = (last.entries - first.entries) / 3;
console.log('RESULT', JSON.stringify({ seconds: Math.round(seconds), deltaEntries: last.entries - first.entries, imagesPerMinute: +(images / seconds * 60).toFixed(1) }));
ws.close();
