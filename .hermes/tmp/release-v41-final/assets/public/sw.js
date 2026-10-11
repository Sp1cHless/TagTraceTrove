//#region src/offline/cache-names.ts
var e = "t3-offline-media-v1", t = "t3-shell-v7", n = [
	"/",
	"/index.html",
	"/manifest.webmanifest"
], r = ["/assets/index-0GrHYOUR.js", "/assets/index-C0otm6y8.css"];
function i() {
	return [.../* @__PURE__ */ new Set([...n, ...r])];
}
function a(e) {
	return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpg|jpeg|webp|avif|svg)$/u.test(e);
}
function o(e) {
	return e.pathname.startsWith("/api/thumbnails/");
}
function s(e) {
	return /^\/api\/assets\/entries\/\d+\/thumbnails\/(?:cover|preview(?:-\d+)?)\.[a-f0-9]{16}\.webp$/u.test(e.pathname);
}
function c(e) {
	return s(e) ? !1 : e.pathname.startsWith("/api/assets/") || e.pathname.startsWith("/assets/") && !a(e.pathname);
}
function l(e) {
	return e.pathname === "/api/sync/capabilities";
}
function u(e, t, n = "cors") {
	let r = new URL(t), { pathname: i } = r;
	return e !== "GET" || l(r) ? {
		kind: "network-only",
		url: t
	} : o(r) ? {
		kind: "thumbnail-resolver",
		url: t
	} : s(r) ? {
		kind: "immutable-thumbnail",
		url: t
	} : a(i) ? {
		kind: "immutable-asset",
		url: t
	} : c(r) ? {
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
var d = t;
async function f(e, t) {
	let n = await caches.open(t), r = await n.match(e);
	if (r !== void 0) return r;
	let i = await fetch(e);
	return i.ok && await n.put(e, i.clone()), i;
}
async function p(e, t, n = {}) {
	let r = await caches.open(t);
	try {
		let t = await fetch(e);
		if (n.fallbackOnUnavailableResponse === !0 && [
			502,
			503,
			504
		].includes(t.status)) {
			let t = await r.match(e);
			if (t !== void 0) return t;
		}
		return t.ok && n.persistOnlineResponse !== !1 && await r.put(e, t.clone()), t;
	} catch {
		return await r.match(e) ?? new Response("Offline", { status: 503 });
	}
}
async function m(e, t) {
	let n = await caches.open(d), r = new Request(t);
	try {
		let t = await fetch(e);
		return t.ok && await n.put(r, t.clone()), t;
	} catch {
		return await n.match(r) ?? new Response("Offline", { status: 503 });
	}
}
function h(t) {
	let n = u(t.request.method, t.request.url, t.request.mode);
	switch (n.kind) {
		case "network-only": return;
		case "immutable-asset":
			t.respondWith(f(t.request, d));
			return;
		case "immutable-thumbnail":
			t.respondWith(f(t.request, e));
			return;
		case "thumbnail-resolver":
			t.respondWith(p(t.request, e, {
				persistOnlineResponse: !1,
				fallbackOnUnavailableResponse: !0
			}));
			return;
		case "library-media":
			t.respondWith(p(t.request, e, { fallbackOnUnavailableResponse: !0 }));
			return;
		case "network-first":
			t.respondWith(p(t.request, d));
			return;
		case "shell":
			t.respondWith(m(t.request, n.url));
			return;
	}
}
self.addEventListener("install", (e) => {
	e.waitUntil((async () => {
		await (await caches.open(d)).addAll(i()), await self.skipWaiting();
	})());
}), self.addEventListener("activate", (e) => {
	e.waitUntil((async () => {
		let e = await caches.keys();
		await Promise.all(e.filter((e) => e.startsWith("t3-shell-") && e !== d).map((e) => caches.delete(e))), await self.clients.claim();
	})());
}), self.addEventListener("fetch", h);
//#endregion
export { e as OFFLINE_MEDIA_CACHE, t as SW_VERSION, h as handleFetch, l as isCapabilities, a as isHashedBuildAsset, s as isImmutableThumbnail, c as isLibraryMedia, o as isThumbnail, p as networkFirst, i as shellUrls, u as strategyFor };


self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url).catch(() => undefined)))),
  );
});
