/*
 * 最小 Service Worker：只缓存「应用壳 + 静态资源」，**不缓存业务数据**（docs/09 §4 阶段 C）。
 *
 * 口径（有意为之）：
 * - `/api/**` 一律走网络，不读也不写缓存 —— 业务数据的唯一事实源是 PostgreSQL，
 *   离线写会与它冲突（同 docs/09「不做业务数据离线写」）。
 * - 导航请求 network-first：优先拿最新 `index.html`（新部署立刻生效），断网时回退到缓存壳。
 * - 带哈希的静态资源（/assets/*.js|css、字体、图标）cache-first：内容指纹变了 URL 就变，
 *   不存在"旧缓存顶替新文件"的问题。
 * - 升级：`VERSION` 变化时 activate 清掉旧缓存；本文件不预缓存构建产物清单
 *   （不引入额外构建插件，保持零新增依赖）。
 */
const VERSION = 'cms-shell-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest'];

const isStaticPath = (pathname) =>
  pathname.startsWith('/assets/') ||
  pathname.startsWith('/fonts/') ||
  pathname.startsWith('/icons/') ||
  /\.(?:js|mjs|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|webmanifest)$/i.test(pathname);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

const put = (cacheName, request, response) => {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(cacheName).then((cache) => cache.put(request, copy)).catch(() => undefined);
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 业务数据永远走网络（含反代到后端的 /api 与 /api/files 下载）
  if (url.pathname.startsWith('/api/')) return;

  // 导航：network-first，断网回退到应用壳
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          put(SHELL_CACHE, request, response);
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/index.html')) || Response.error()),
    );
    return;
  }

  if (!isStaticPath(url.pathname)) return;

  // 静态资源：cache-first
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          put(STATIC_CACHE, request, response);
          return response;
        }),
    ),
  );
});
