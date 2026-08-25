/* 教育資金贈与マネージャー の Service Worker。
 *
 * 方針は stale-while-revalidate（SWR）。
 * キャッシュがあれば即座に返して表示を止めず、裏側で新しいものを取り直して
 * キャッシュを差し替える。差し替えた内容は次回の起動から反映される。
 *
 * このアプリは外部と通信しません（記録はすべて localStorage）。
 * つまり電波がなくても、窓口や学校で「あと枠がいくら残っているか」を
 * 確認するところまで普通に使えます。
 *
 * 収録ファイルを増やしたときは PRECACHE に足し、VERSION を上げる。
 */

const VERSION = 'v8';
const CACHE = `education-fund-gift-${VERSION}`;

/** 初回インストール時にまとめて取っておくファイル。これだけあればオフラインでも開ける。 */
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/icon.svg',
  'assets/favicon-32.png',
  'assets/apple-touch-icon.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 1件でも失敗するとインストール自体が転ぶので、個別に入れて失敗は握りつぶす。
    const results = await Promise.allSettled(
      PRECACHE.map((path) => cache.add(new Request(path, { cache: 'reload' })))
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) console.warn(`[sw] ${failed}件のプリキャッシュに失敗しました`);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('education-fund-gift-') && n !== CACHE)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/** ページ側の「更新して再読み込み」ボタンから呼ばれる。 */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(respond(event));
});

async function respond(event) {
  const request = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  const fromNetwork = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // キャッシュがあれば即返し、取り直しは裏で最後まで走らせる。
  if (cached) {
    event.waitUntil(fromNetwork);
    return cached;
  }

  const fresh = await fromNetwork;
  if (fresh) return fresh;

  // オフラインかつ未キャッシュ。ページを開こうとしているならアプリ本体を返す。
  if (request.mode === 'navigate') {
    const shell = (await cache.match('index.html')) || (await cache.match('./'));
    if (shell) return shell;
  }
  return Response.error();
}
