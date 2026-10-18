// 这个 SW 只为两件事存在：① 满足 Chrome 的 PWA 可安装性；② 把「URL 里带内容哈希」的
// 静态资源留在本地，手机冷启动不必再把几 MB 的客户端 bundle 从隧道里重新拉一遍
// （实测首屏 JS 线上 ~1.9MB，而隧道只有 160KB/s 量级）。
//
// 缓存的边界（踩过「下拉刷新拿到旧页面」的坑，这条线不要越）：
//   - 只碰 /plugins/、/assets/、/dg-asset/、/pwa/ 下的 GET 请求：它们的 URL 带 rev 或
//     内容哈希，文件变了 URL 必变，所以 cache-first 不可能拿到旧代码；
//   - 文档（HTML）与 /api 一律不拦截、不缓存——不调用 respondWith 时浏览器直接走网络，
//     刷新永远是最新的页面与会话状态；
//   - sw.js 自己不缓存，否则 SW 永远更新不了。
const VERSION = 'v3'
const CACHE = 'dg-static-' + VERSION
const MAX_ENTRIES = 80
const STATIC_PATH = /^\/(?:plugins\/|assets\/|dg-asset\/|pwa\/)/

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/pwa/sw.js') return
  if (!STATIC_PATH.test(url.pathname)) return

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const hit = await cache.match(req)
    if (hit) return hit
    const res = await fetch(req)
    if (res.ok && res.type === 'basic') {
      await cache.put(req, res.clone())
      const keys = await cache.keys()
      if (keys.length > MAX_ENTRIES) {
        await Promise.all(keys.slice(0, keys.length - MAX_ENTRIES).map((k) => cache.delete(k)))
      }
    }
    return res
  })())
})
