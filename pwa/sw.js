// 最小 service worker：只为满足 Chrome 的 PWA 可安装性条件（需要注册一个带
// fetch 处理器的 SW）。不做任何缓存，所有请求照常走网络（fetch 处理器不调用
// respondWith 时请求原样放行）。后续做 Web Push 时在这里加 push 事件处理。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => { })
