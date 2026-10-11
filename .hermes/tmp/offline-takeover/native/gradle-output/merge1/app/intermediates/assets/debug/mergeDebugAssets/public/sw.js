//#region src/offline/cache-names.ts
var e = "t3-offline-media-v1", t = `${e}-s`;
function n(e) {
	let n = 2166136261;
	for (let t = 0; t < e.length; t += 1) n ^= e.charCodeAt(t), n = Math.imul(n, 16777619) >>> 0;
	return `${t}${n % 256}`;
}
function r(t) {
	return [n(t), e];
}
//#endregion
//#region src/sw/service-worker.ts
var i = "t3-shell-v7", a = [
	"/",
	"/index.html",
	"/manifest.webmanifest"
], o = ["/assets/index-BZCR_PAO.js", "/assets/index-jZVlzgVR.css"];
function s() {
	return [.../* @__PURE__ */ new Set([...a, ...o])];
}
function c(e) {
	return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpg|jpeg|webp|avif|svg)$/u.test(e);
}
function l(e) {
	return e.pathname.startsWith("/api/thumbnails/");
}
function u(e) {
	return /^\/api\/assets\/entries\/\d+\/thumbnails\/(?:cover|preview(?:-\d+)?)\.[a-f0-9]{16}\.webp$/u.test(e.pathname);
}
function d(e) {
	return u(e) ? !1 : e.pathname.startsWith("/api/assets/") || e.pathname.startsWith("/assets/") && !c(e.pathname);
}
function f(e) {
	return e.pathname === "/api/sync/capabilities";
}
function p(e, t, n = "cors") {
	let r = new URL(t), { pathname: i } = r;
	return e !== "GET" || f(r) ? {
		kind: "network-only",
		url: t
	} : l(r) ? {
		kind: "thumbnail-resolver",
		url: t
	} : u(r) ? {
		kind: "immutable-thumbnail",
		url: t
	} : c(i) ? {
		kind: "immutable-asset",
		url: t
	} : d(r) ? {
		kind: "library-media",
		url: t
	} : i === "/" || i === "/index.html" || i === "/manifest.webmanifest" ? {
		kind: "shell",
		url: t
	} : n === "navigate" ? {
		kind: "shell",
		url: "/index.html"
	} : {
		kind: "network-only",
		url: t
	};
}
var m = i;
async function h(e, t) {
	for (let n of t) {
		let t = await (await caches.open(n)).match(e);
		if (t !== void 0) return t;
	}
}
async function g(e, t) {
	let n = await h(e, t);
	if (n !== void 0) return n;
	let r = await fetch(e);
	return r.ok && await (await caches.open(t[0])).put(e, r.clone()), r;
}
async function _(e, t, n = {}) {
	try {
		let r = await fetch(e);
		if (n.fallbackOnUnavailableResponse === !0 && [
			502,
			503,
			504
		].includes(r.status)) {
			let n = await h(e, t);
			if (n !== void 0) return n;
		}
		return r.ok && n.persistOnlineResponse !== !1 && await (await caches.open(t[0])).put(e, r.clone()), r;
	} catch {
		return await h(e, t) ?? new Response("Offline", { status: 503 });
	}
}
async function v(e, t) {
	let n = await caches.open(m), r = new Request(t);
	try {
		let t = await fetch(e);
		return t.ok && await n.put(r, t.clone()), t;
	} catch {
		return await n.match(r) ?? new Response("Offline", { status: 503 });
	}
}
function y(e) {
	let t = p(e.request.method, e.request.url, e.request.mode);
	switch (t.kind) {
		case "network-only": return;
		case "immutable-asset":
			e.respondWith(g(e.request, [m]));
			return;
		case "immutable-thumbnail":
			e.respondWith(g(e.request, r(e.request.url)));
			return;
		case "thumbnail-resolver":
			e.respondWith(_(e.request, r(e.request.url), {
				persistOnlineResponse: !1,
				fallbackOnUnavailableResponse: !0
			}));
			return;
		case "library-media":
			e.respondWith(_(e.request, r(e.request.url), { fallbackOnUnavailableResponse: !0 }));
			return;
		case "network-first":
			e.respondWith(_(e.request, [m]));
			return;
		case "shell":
			e.respondWith(v(e.request, t.url));
			return;
	}
}
self.addEventListener("install", (e) => {
	e.waitUntil((async () => {
		await (await caches.open(m)).addAll(s()), await self.skipWaiting();
	})());
}), self.addEventListener("activate", (e) => {
	e.waitUntil((async () => {
		let e = await caches.keys();
		await Promise.all(e.filter((e) => e.startsWith("t3-shell-") && e !== m).map((e) => caches.delete(e))), await self.clients.claim();
	})());
}), self.addEventListener("fetch", y);
//#endregion
export { i as SW_VERSION, y as handleFetch, f as isCapabilities, c as isHashedBuildAsset, u as isImmutableThumbnail, d as isLibraryMedia, l as isThumbnail, _ as networkFirst, r as offlineMediaCacheNames, s as shellUrls, p as strategyFor };


self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url).catch(() => undefined)))),
  );
});
