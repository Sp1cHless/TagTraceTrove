// Measures one Entry open (and its return) on the installed app, through the WebView debugger.
//   node entry-open.mjs            # idle transport
//   node entry-open.mjs --load 60  # with background media fetches saturating the transport
const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const page = list.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0;
const send = (method, params) => new Promise((res) => {
  const mine = ++id;
  const onMessage = (e) => { const d = JSON.parse(e.data); if (d.id === mine) { ws.removeEventListener('message', onMessage); res(d.result); } };
  ws.addEventListener('message', onMessage);
  ws.send(JSON.stringify({ id: mine, method, params }));
});
const loadFlag = process.argv.indexOf('--load');
const backgroundFetches = loadFlag === -1 ? 0 : Number(process.argv[loadFlag + 1] ?? 50);

const expression = `(async () => {
  const background = ${backgroundFetches};
  const waitFor = (selector, timeout) => new Promise((resolve) => {
    if (document.querySelector(selector)) return resolve(0);
    const started = performance.now();
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) { observer.disconnect(); resolve(performance.now() - started); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(-1); }, timeout);
  });
  // Land on Home, where the recent cards live.
  const home = document.querySelector("[data-testid=sidebar-home]"); if (home) home.click();
  await waitFor("[data-testid=home-recent-card]", 5000);
  const card = document.querySelector("[data-testid=home-recent-card]");
  if (!card) return JSON.stringify({ error: "no home card" });
  const title = card.innerText.replace(/\\s+/g, " ").slice(0, 40);

  // Optional background traffic: exactly what the media download does, but read-only.
  let loadStop = false;
  const loadStarted = performance.now();
  const loadWork = (async () => {
    if (background === 0) return 0;
    const names = await caches.keys();
    const urls = [];
    for (const name of names) {
      if (!name.startsWith("t3-offline-media-v1-s") || urls.length >= background * 3) continue;
      const keys = await (await caches.open(name)).keys();
      for (const k of keys) { if (urls.length < background * 3) urls.push(k.url); }
    }
    let done = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (!loadStop && done < urls.length) {
        const url = urls[done]; done += 1;
        try { const r = await fetch(url, { cache: "no-store" }); await r.blob(); } catch { /* keep the load going */ }
      }
    }));
    return done;
  })();

  const started = performance.now();
  const detailAppeared = waitFor("[data-testid=entry-detail]", 15000);
  const boardAppeared = waitFor("[data-testid=entry-information-board]", 15000);
  const ratingsAppeared = waitFor("[data-testid=entry-ratings]", 15000);
  // The card is an <article>; the handler lives on the button inside it.
  (card.querySelector("button") ?? card).click();
  const [detailMs, boardMs, ratingsMs] = await Promise.all([detailAppeared, boardAppeared, ratingsAppeared]);
  const openedAt = performance.now();

  const back = document.querySelector("[data-testid=entry-back]");
  const backStarted = performance.now();
  const homeAgain = waitFor("[data-testid=home-recent-card]", 15000);
  if (back) back.click();
  const backMs = await homeAgain;
  const backDone = performance.now();

  loadStop = true;
  const loadFetches = await loadWork;
  return JSON.stringify({
    card: title,
    openMs: Math.round(detailMs),
    informationBoardMs: Math.round(boardMs),
    ratingsMs: Math.round(ratingsMs),
    detailToBackMs: Math.round(backStarted - openedAt),
    backMs: Math.round(backMs),
    backWaitMs: Math.round(backDone - backStarted),
    backgroundFetches: loadFetches,
    backgroundMs: Math.round(backDone - loadStarted),
  });
})()`;
const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
console.log(out.result?.value ?? JSON.stringify(out));
ws.close();
