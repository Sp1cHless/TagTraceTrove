import process from 'node:process';

const [,, mode, ...rest] = process.argv;
const listUrl = 'http://127.0.0.1:9222/json/list';

async function pages() {
  const res = await fetch(listUrl);
  return res.json();
}

async function pickPage() {
  const all = await pages();
  const wanted = all.filter((p) => p.type === 'page');
  const app = wanted.find((p) => (p.url || '').includes('localhost')) ?? wanted[0];
  if (!app) throw new Error('no page: ' + JSON.stringify(all.map((p) => [p.type, p.url])));
  return app;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const messageId = ++id;
        ws.send(JSON.stringify({ id: messageId, method, params }));
        return new Promise((res, rej) => pending.set(messageId, { res, rej }));
      },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', (event) => reject(new Error('ws error ' + (event?.message ?? ''))));
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        const { res, rej } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) rej(new Error(JSON.stringify(data.error)));
        else res(data.result);
      }
    });
  });
}

const page = await pickPage();
const client = await connect(page.webSocketDebuggerUrl);
await client.send('Runtime.enable');

if (mode === 'pages') {
  console.log(JSON.stringify(await pages(), null, 2));
  client.close();
  process.exit(0);
}

const expression = mode === 'eval' ? rest.join(' ') : rest.join(' ');
const result = await client.send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  timeout: 120000,
});
if (result.exceptionDetails) {
  console.error('EXCEPTION', JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails));
  process.exit(1);
}
console.log(typeof result.result.value === 'string' ? result.result.value : JSON.stringify(result.result.value, null, 2));
client.close();
