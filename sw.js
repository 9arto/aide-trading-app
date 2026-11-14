// Service worker : l'application s'ouvre hors ligne ; les données sont toujours demandées au réseau d'abord.
const CACHE = "signaux-v5";
const COQUILLE = ["./", "index.html", "styles.css", "app.js", "manifest.json", "icone.svg"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(COQUILLE)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(cles => Promise.all(cles.filter(c => c !== CACHE).map(c => caches.delete(c)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(reponse => {
    const copie = reponse.clone();
    caches.open(CACHE).then(c => c.put(e.request, copie));
    return reponse;
  }).catch(() => caches.match(e.request)));
});
