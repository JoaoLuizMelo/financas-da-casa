// Finanças da Casa — service worker: permite instalar e abrir o app mesmo com internet fraca.
// Estratégia: rede primeiro para os arquivos do app (sempre a versão mais nova), cópia local como reserva.
const CACHE = "fc-v1";
const ARQUIVOS = ["./", "index.html", "styles.css", "app.js", "nucleo.js", "ocr.js", "firebase-config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Firebase, fontes e leitor de notas seguem direto
  e.respondWith(fetch(e.request).then(r => { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
