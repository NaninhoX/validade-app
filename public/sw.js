// Guarda a casca do app para abrir sem rede. As chamadas /api nunca passam pelo cache.
const CACHE = 'validade-v33';
const CASCA = ['/', '/app.css', '/coletor.css', '/common.js', '/scanner.js', '/mapa.js', '/geom.js', '/coletor.js', '/causa.js', '/causa.css', '/folha.js', '/folha.css', '/auditoria.js', '/conferencias.js', '/offline.js', '/vendor/zxing.min.js', '/rma.js', '/tv.js', '/tv.css', '/lista-nota.js', '/conferencias.css', '/estoque.js', '/dashboard.js', '/manifest.webmanifest', '/icon.svg', '/vendor/fonts/roboto-latin-400-normal.woff2', '/vendor/fonts/roboto-latin-500-normal.woff2', '/vendor/fonts/roboto-latin-700-normal.woff2'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CASCA)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Arquivos da casca: do cache primeiro (abre na hora, inclusive em modo avião ou com Wi-Fi que não dá internet); a versão nova chega pela atualização deste arquivo.
// Demais páginas (impressão, login): rede primeiro, cache se a rede falhar.
const NA_CASCA = new Set(CASCA);
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api')) return;
  if (NA_CASCA.has(u.pathname)) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(x => { if (x.ok) { const c = x.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return x; })));
    return;
  }
  e.respondWith(
    fetch(e.request).then(r => { if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); } return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
