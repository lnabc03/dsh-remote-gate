// dsh-remote-gate — 最小化 DSH 远程访问网关
// 单文件、零依赖。只做三件事：
//   1. 令牌认证（?t=<token> 首次登录 → HttpOnly Cookie）
//   2. 反向代理到本机 DSH Web UI（含 WebSocket 隧道），头清洗后上游看到的永远是本机访问
//   3. HTML 注入 manifest/meta，让手机可以「添加到主屏」
//
// 运行：node gateway.mjs
// 配置：config.json（首次运行自动生成随机 token），或环境变量覆盖：
//   DSH_GATE_CONFIG       配置文件路径（默认同目录 config.json；测试/多实例用）
//   DSH_GATE_PORT         监听端口（默认 3088）
//   DSH_GATE_BIND         监听地址（默认按 config.json.mode：lan → 0.0.0.0，其余 → 127.0.0.1）
//   DSH_GATE_TARGET_PORT  DSH Web UI 端口（默认 3080）
//   DSH_GATE_TOKEN        访问令牌（设置后不再读写 config.json）
//   DSH_GATE_DOMAIN       公网域名（用于打印登录链接，如 dsh.example.com；lan/cf 模式忽略）

import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import dgram from 'node:dgram'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---- config ---------------------------------------------------------------
const CONFIG_PATH = process.env.DSH_GATE_CONFIG || path.join(__dirname, 'config.json')
let fileCfg = {}
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { /* first run */ }

let TOKEN = process.env.DSH_GATE_TOKEN || fileCfg.token
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('base64url')
  // 合并保留已有字段（如 setup 写进来的 domain），而不是整体覆盖
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...fileCfg, token: TOKEN }, null, 2) + '\n', { mode: 0o600 })
}
const PORT = Number(process.env.DSH_GATE_PORT || fileCfg.port || 3088)
const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = Number(process.env.DSH_GATE_TARGET_PORT || fileCfg.targetPort || 3080)
const DOMAIN = process.env.DSH_GATE_DOMAIN || fileCfg.domain || ''
const BIND_HOST = process.env.DSH_GATE_BIND || (fileCfg.mode === 'lan' ? '0.0.0.0' : '127.0.0.1')
// cf（Cloudflare Tunnel）模式：CF 边缘只保证发 Cf-Visitor，X-Forwarded-Proto 时有时无，
// 但入口恒定是 HTTPS——直接强制按 https 处理（Cookie Secure、登录链接 https）
const FORCE_HTTPS = fileCfg.mode === 'cf'
const COOKIE_NAME = 'dg_token'
const HTML_LIMIT = 4 * 1024 * 1024

// ---- dsh 自带浏览器会话认证的桥接（dsh >= 0.2） --------------------------------
// dsh 0.2 起 `dsh web` 自己对 `/` 与 `/api` 做认证：启动时打印一次性 `?token=<启动令牌>`，
// 拿它访问根路径才换来 `dsh-auth-*` 签名 Cookie（HttpOnly + SameSite=Strict，受众=请求
// Host 的 authority）。没有这个 Cookie，网关转发出去的每一个请求都会被 dsh 401 挡下——
// 「把 Host 改写成 127.0.0.1:3080 就能冒充本机」不再成立，因为本机浏览器同样得先出示 Cookie。
//
// **这份 Cookie 由网关自己持有，绝不让浏览器参与交换。** 网关把 Host 固定重写成
// 127.0.0.1:3080，所以 Cookie 名（sha256(authority)）与受众对所有远端设备、所有隧道模式
// 都是同一个值，一份就够全网用：
//   - 启动令牌由 start.mjs 从 dsh stdout 抓进 DSH_TOKEN_FILE（已 gitignore，每次 dsh 启动
//     重写），网关按 mtime 懒读；需要时（首次导航、或缓存被 dsh 拒绝）就 GET
//     `/?token=<令牌>` 换一份，缓存 10 分钟；
//   - 转发时丢掉客户端的 `dsh-auth-*`、换上自己那份；响应里的 `dsh-auth-*` Set-Cookie 也
//     不下发。浏览器只留网关自己的 dg_token。
//
// 反过来做（401 → 把浏览器重定向到 `/?token=…` → dsh 种 Cookie → 303 回 `/`）是踩过的坑：
// 它要求 Cookie 在整条重定向链里落盘并回传，而 WebKit 对跨站发起的导航链不送
// SameSite=Strict Cookie，dsh 又只认同名 Cookie 的**第一份**（实测）。iPhone 上的表现就是
// 无限打转、浏览器报「重定向次数过多」，access log 里是一串 `302 /` → `303 /?token=…`。
const DSH_TOKEN_FILE = process.env.DSH_GATE_DSH_TOKEN_FILE || path.join(__dirname, '.dsh-web-token')
const DSH_TOKEN_FILE_TTL = 1000 // stat 节流：每秒最多查一次 mtime
let dshTok = { value: process.env.DSH_GATE_DSH_TOKEN || '', mtime: -1, at: 0 }

function dshLaunchToken() {
  if (process.env.DSH_GATE_DSH_TOKEN) return process.env.DSH_GATE_DSH_TOKEN
  const now = Date.now()
  if (now - dshTok.at < DSH_TOKEN_FILE_TTL) return dshTok.value
  dshTok.at = now
  try {
    const st = fs.statSync(DSH_TOKEN_FILE)
    if (st.mtimeMs !== dshTok.mtime) {
      dshTok.mtime = st.mtimeMs
      dshTok.value = fs.readFileSync(DSH_TOKEN_FILE, 'utf8').trim()
    }
  } catch {
    dshTok.value = ''
    dshTok.mtime = -1
  }
  return dshTok.value
}

// 导航请求：浏览器地址栏/书签/主屏图标发起的、会渲染成页面的请求。只有这类请求值得
// 重定向去换 Cookie；XHR/fetch（/api、/assets）拿到 401 就该原样回给前端，不能把它
// 重定向成一段 HTML。
function isNavRequest(req) {
  return String(req.headers.accept || '').includes('text/html')
}

let noTokenWarnedAt = 0
function warnNoDshToken() {
  const now = Date.now()
  if (now - noTokenWarnedAt < 60_000) return
  noTokenWarnedAt = now
  console.log('未取得 dsh 启动令牌，远端导航会 401；用 npm start 拉起 dsh，或设 DSH_GATE_DSH_TOKEN')
}

// ---- 网关自持的 dsh 会话 Cookie ------------------------------------------------
const DSH_COOKIE_PREFIX = 'dsh-auth-'
const MINT_TTL = 600_000 // 缓存 10 分钟：dsh 的 Cookie 本身 30 天有效，这里只防长期不刷新
const minted = { pair: '', exp: 0, inflight: null }

function freshDshCookie() {
  return minted.pair !== '' && Date.now() < minted.exp ? minted.pair : ''
}

// 向 dsh 换一份会话 Cookie；force = 「缓存那份已被 dsh 拒绝」，丢弃重换。并发单飞。
function mintDshCookie(force = false) {
  if (!force && freshDshCookie() !== '') return Promise.resolve(freshDshCookie())
  if (minted.inflight !== null) return minted.inflight
  const tok = dshLaunchToken()
  if (tok === '') return Promise.resolve('')
  if (force) { minted.pair = ''; minted.exp = 0 }
  const p = new Promise((resolve) => {
    const req = http.request({
      host: TARGET_HOST, port: TARGET_PORT, method: 'GET',
      path: '/?token=' + encodeURIComponent(tok),
      headers: { host: TARGET_HOST + ':' + TARGET_PORT, accept: 'text/html' },
    }, (res) => {
      const raw = [].concat(res.headers['set-cookie'] || [])
        .find((s) => String(s).startsWith(DSH_COOKIE_PREFIX))
      res.resume()
      if (raw !== undefined) {
        minted.pair = String(raw).split(';')[0]
        minted.exp = Date.now() + MINT_TTL
      }
      resolve(minted.pair)
    })
    req.on('error', () => resolve(''))
    req.setTimeout(5000, () => req.destroy())
    req.end()
  }).finally(() => { minted.inflight = null })
  minted.inflight = p
  return p
}

// ---- helpers ----------------------------------------------------------------
function parseCookies(req) {
  const out = {}
  const h = req.headers.cookie
  if (typeof h !== 'string' || h === '') return out
  for (const part of h.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = part.slice(i + 1).trim()
  }
  return out
}

function tokenEq(a, b) {
  const ba = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb)
}

function queryTicket(url) {
  const q = String(url || '').indexOf('?')
  if (q < 0) return undefined
  const m = url.slice(q + 1).match(/(?:^|&)t=([^&]*)/)
  return m ? decodeURIComponent(m[1]) : undefined
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 列出所有非回环 IPv4（仅展示，不参与绑定决策）
function lanCandidates() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (!iface.internal && (iface.family === 'IPv4' || iface.family === 4)) out.push(iface.address)
    }
  }
  return out
}

// 探测局域网 IP：用 UDP connect 让操作系统选出「默认路由所在网卡」的地址（不真的发包）。
// 直接取枚举第一个会踩中 VMware/Hyper-V 等虚拟网卡——那种地址手机永远够不到（踩过）。
function lanIp() {
  return new Promise((resolve) => {
    const fallback = () => resolve(lanCandidates()[0])
    try {
      const s = dgram.createSocket('udp4')
      s.on('error', fallback)
      s.connect(80, '192.0.2.1', () => { // TEST-NET-1，仅触发路由选择
        let addr
        try { addr = s.address().address } catch { }
        s.close()
        resolve(addr || lanCandidates()[0])
      })
    } catch {
      fallback()
    }
  })
}

// 转发到 dsh 的头白名单：抹掉一切能暴露「非本机访问」的痕迹
// - host 重写为 127.0.0.1:3080
// - origin 重写为 http://127.0.0.1:3080（不丢弃！dsh 生态插件如 dshmarket 的
//   same-origin POST 校验要求 Origin 存在且与 Host 一致，缺了直接 403 untrusted
//   origin——本机浏览器发 POST 本来就带这个 Origin，重写后才算「不可区分」）；
//   仅当原始请求带 origin 时才重写，不带则不加（与本机浏览器行为一致）
// - 丢弃 referer / x-forwarded-* / forwarded / x-real-ip
// - accept-encoding 只在导航请求（Accept 含 text/html，可能返回 HTML 需要注入）上丢弃，
//   强制未压缩以便注入；静态资源/API 放行压缩——全量摘除会让 JS bundle 以未压缩体积
//   过隧道，流量翻好几倍（服务器按出站计费时这是最大的浪费源，实测半天近 1G）
// - cookie 中剔除网关自己的 dg_token
function cleanHeaders(req) {
  const drop = new Set(['host', 'origin', 'referer', 'connection', 'keep-alive', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
    'forwarded', 'x-real-ip'])
  const isNav = isNavRequest(req)
  const out = {}
  for (const k in req.headers) {
    const lk = k.toLowerCase()
    if (drop.has(lk) || lk.startsWith('x-forwarded-')) continue
    if (lk === 'accept-encoding' && isNav) continue
    if (lk === 'cookie') {
      const mint = freshDshCookie()
      const kept = String(req.headers[k]).split(';').map((p) => p.trim()).filter(Boolean)
        .filter((p) => {
          const name = p.split('=')[0].trim()
          if (name === COOKIE_NAME) return false
          // 网关自己那份 Cookie 在手时，客户端的同名 Cookie 一律丢掉：dsh 只认同名第一份，
          // 客户端残留的旧值会把它盖成 401（移动端重定向环的成因之一）
          return !(mint !== '' && name.startsWith(DSH_COOKIE_PREFIX))
        })
      if (mint !== '') kept.push(mint)
      if (kept.length > 0) out[k] = kept.join('; ')
      continue
    }
    out[k] = req.headers[k]
  }
  out['host'] = TARGET_HOST + ':' + TARGET_PORT
  if (req.headers.origin !== undefined) out['origin'] = 'http://' + TARGET_HOST + ':' + TARGET_PORT
  return out
}

// ---- 流量统计：验证压缩收益；仅累计打印，不影响转发 -------------------------------
// 口径：下行数「写回浏览器」一侧的字节（post-gzip），即真实过隧道/计费的字节；
// 上行数请求体原始字节（本来就极小）。paths 每项记 {b: 字节, n: 请求数}——
// 次数用来区分「少量大响应」与「高频重拉」，排查热点靠它。
const meter = { up: 0, down: 0, upTotal: 0, downTotal: 0, paths: new Map() }
const meterUp = (n) => { meter.up += n; meter.upTotal += n }
function meterReq(pathKey) {
  const e = meter.paths.get(pathKey) || { b: 0, n: 0 }
  e.n++
  meter.paths.set(pathKey, e)
}
function meterDown(pathKey, n) {
  meter.down += n; meter.downTotal += n
  const e = meter.paths.get(pathKey) || { b: 0, n: 0 }
  e.b += n
  meter.paths.set(pathKey, e)
}
function fmtBytes(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB'
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB'
  return n + ' B'
}
setInterval(() => {
  if (meter.up + meter.down === 0) return // 静默时段不刷日志
  const top = [...meter.paths.entries()].sort((a, b) => b[1].b - a[1].b).slice(0, 3)
    .map(([p, e]) => (p.length > 60 ? '…' + p.slice(-59) : p) + ' ' + fmtBytes(e.b) + '×' + e.n).join(', ')
  console.log(`流量: 最近 1h ↓${fmtBytes(meter.down)} ↑${fmtBytes(meter.up)}；累计 ↓${fmtBytes(meter.downTotal)} ↑${fmtBytes(meter.upTotal)}` + (top ? `；热点: ${top}` : ''))
  meter.up = 0; meter.down = 0; meter.paths.clear()
}, 3600_000).unref()

// ---- auth failure soft limit（防在线爆破；frp 下所有来源都是 127.0.0.1，故按全局计） ----
let fails = []
function failLimited() {
  const now = Date.now()
  fails = fails.filter(t => now - t < 60_000)
  return fails.length >= 30
}
const noteFail = () => fails.push(Date.now())

// ---- pages -------------------------------------------------------------------
function page(title, body) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0f1115;color:#e6e6e6;font:16px/1.6 system-ui,sans-serif}' +
    '.card{max-width:22rem;padding:2rem;text-align:center}.muted{color:#8b8f98;font-size:.9em}</style>' +
    '</head><body><div class="card">' + body + '</div></body></html>'
}

const UNAUTH_PAGE = page('未授权', '<h2>🔒 DSH Remote Gate</h2><p class="muted">首次访问需带 <code>?t=&lt;token&gt;</code>。</p>')
const DENY_PAGE = page('令牌无效', '<h2>🚫 令牌无效</h2>')
const LIMITED_PAGE = page('请稍后再试', '<h2>⏳ 尝试过于频繁</h2><p class="muted">一分钟后再试。</p>')
const NO_SESSION_PAGE = page('会话未建立',
  '<h2>⚠️ dsh 会话未建立</h2><p class="muted">启动令牌缺失或已失效。用 start.bat 重启，或用新的登录链接进入。</p>')

function sendPage(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

// ---- /pwa/* 静态资产 -----------------------------------------------------------
const PWA_DIR = path.join(__dirname, 'pwa')
const MIME = {
  '.json': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

function servePwa(req, res) {
  const rel = decodeURIComponent(req.url.slice('/pwa/'.length).split('?')[0])
  if (!rel || rel.includes('..') || rel.includes('\0') || rel.startsWith('/')) {
    res.writeHead(404); res.end('Not Found'); return
  }
  const file = path.normalize(path.join(PWA_DIR, rel))
  if (!file.startsWith(PWA_DIR + path.sep)) { res.writeHead(404); res.end('Not Found'); return }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    }
    // sw.js 在 /pwa/ 下，默认作用域只有 /pwa/；要控制整站必须显式放宽
    if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/'
    res.writeHead(200, headers)
    res.end(data)
  })
}

// ---- HTML 注入：仅 manifest + 安装相关 meta -------------------------------------
const INJECT_SNIPPET =
  '<link rel="manifest" href="/pwa/manifest.json">' +
  '<meta name="theme-color" content="#0f1115">' +
  '<meta name="mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
  '<meta name="apple-mobile-web-app-title" content="DSH">' +
  '<link rel="apple-touch-icon" href="/pwa/icons/icon-192.png">' +
  // 注册最小 SW：Android Chrome 的可安装性硬性条件；对页面行为零影响
  '<script>if("serviceWorker"in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/pwa/sw.js",{scope:"/"}).catch(function(){})})}</script>'

// crypto.randomUUID 仅在安全上下文（HTTPS 或 localhost）存在；lan 模式是明文 HTTP，
// 浏览器不提供它，dsh 前端一调用（选工作区/改设置等）即抛 crypto.randomUUID is not a function。
// 用 getRandomValues（HTTP 下可用）垫一个 RFC4122 v4 实现。仅绑 0.0.0.0（lan）时注入；
// frp/ssh 走 HTTPS 安全上下文，原生就有，保持注入内容不变。
const UUID_POLYFILL =
  '<script>if(window.crypto&&!crypto.randomUUID){crypto.randomUUID=function(){' +
  'var b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;' +
  'for(var h="",i=0;i<16;i++)h+=(b[i]<16?"0":"")+b[i].toString(16);' +
  'return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}</script>'

function injectHtml(html) {
  // 必须紧跟 <head> 之后：dsh 自带 <link rel="manifest">（无 PNG 图标，不满足
  // Chrome 安装条件），规范规定只认文档中第一个 manifest 链接，先到先得。
  const snippet = (BIND_HOST === '0.0.0.0' ? UUID_POLYFILL : '') + INJECT_SNIPPET
  const open = /<head[^>]*>/i.exec(html)
  if (open) {
    const at = open.index + open[0].length
    return html.slice(0, at) + snippet + html.slice(at)
  }
  const close = /<\/head>/i.exec(html)
  if (close) return html.slice(0, close.index) + snippet + html.slice(close.index)
  return html + snippet
}

// ---- 反向代理 -------------------------------------------------------------------
// 网关侧 gzip：dsh 上游自己完全不压缩（实测 vendor.js 745KB 带不带 Accept-Encoding 都一样大），
// 而服务器按出站计费，压缩只能在网关做。只压：客户端接受 gzip + 状态 200 + 上游未压缩 +
// 可压类型 + 非流式。超过缓冲上限或流式响应维持原样透传。
const GZIP_TYPE = /^(text\/|application\/(json|javascript|manifest\+json|xml|wasm)|image\/svg\+xml)/
const GZIP_MIN = 1024 // 太小的响应压缩反而膨胀

// 长响应保活：上游迟迟不给响应头时（/compact 这类同步长命令轻松超过 60s），隧道链路上的
// 中间反代（nginx 默认 proxy_read_timeout 60s）会先把连接掐成 504。两条互补机制：
//
// 1) 102 心跳（通用慢路径）：等响应头阶段周期性下发 102 Processing 中间响应（HTTP/1.1
//    合法 1xx，Chromium/Firefox fetch 透明忽略），重置沿途读超时。上游响应头一到即停。
//    DSH_GATE_HEARTBEAT_MS 可调，0 关闭。**WebKit 客户端不发**：Safari/iOS 的 fetch 对
//    1xx 中间响应有已知 bug（同 Cloudflare 103 Early Hints 打挂 Safari 一案），收到 102
//    后最终响应到达时 fetch 直接以 "Load failed" 拒绝（命令已在服务端执行完，客户端却报错）。
//
// 2) drip（仅 POST /api/commands/execute，同步长命令的专属通道，WebKit 安全）：宽限期
//    （DSH_GATE_DRIP_GRACE_MS，默认 20s，小于一切常见代理读超时）内上游未响应，则抢先
//    向客户端提交「200 + chunked」，此后每 DSH_GATE_DRIP_MS 滴一个空格 chunk 保活——
//    有字节流动，沿途读超时（含 CF 边缘 100s TTFP/524）全部被重置；JSON 容忍前导空白，
//    response.json()/JSON.parse 不受影响。宽限期内就到了的响应走正常透传，状态码无损。
//    代价：宽限期后才失败的命令无法传达真实 HTTP 状态（客户端按 200 收到错误正文）——
//    命令校验类错误都是秒回，只有真正跑长的命令才可能踩到，可接受。
const HEARTBEAT_MS = Number(process.env.DSH_GATE_HEARTBEAT_MS ?? 25_000)
const DRIP_PATH = '/api/commands/execute'
const DRIP_GRACE_MS = Number(process.env.DSH_GATE_DRIP_GRACE_MS ?? 20_000)
const DRIP_MS = Number(process.env.DSH_GATE_DRIP_MS ?? 25_000)

// WebKit fetch 遇 1xx 中间响应会炸；iOS 上所有浏览器（含 CriOS/FxiOS/EdgiOS）都是 WebKit
function isWebKit(req) {
  const ua = String(req.headers['user-agent'] || '')
  if (/iP(hone|ad|od)/.test(ua)) return true
  return ua.includes('Macintosh') && ua.includes('Safari/') && !/Chrom(e|ium)\/|Edg\//.test(ua)
}

function forward(req, res) {
  const clientGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
  // 下行计在写回浏览器这一侧（post-gzip 才是真实过隧道字节）；包装 write/end 以覆盖
  // pipe 透传、缓冲改写、超上限回退三种路径
  const pathKey = String(req.url || '').split('?')[0]
  meterReq(pathKey)
  const resWrite = res.write.bind(res)
  const resEnd = res.end.bind(res)
  const countChunk = (chunk) => {
    if (!chunk || typeof chunk === 'function') return
    meterDown(pathKey, typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length)
  }
  res.write = (chunk, ...rest) => { countChunk(chunk); return resWrite(chunk, ...rest) }
  res.end = (chunk, ...rest) => { countChunk(chunk); return resEnd(chunk, ...rest) }
  const isDrip = DRIP_GRACE_MS > 0 && req.method === 'POST' && pathKey === DRIP_PATH
  let heartbeat = null
  if (!isDrip && !isWebKit(req) && HEARTBEAT_MS > 0 && req.httpVersion !== '1.0') {
    heartbeat = setInterval(() => {
      try { if (!res.headersSent && !res.writableEnded) res.writeProcessing() } catch { }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }
  const stopHeartbeat = () => { if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null } }
  // drip：宽限期后抢先提交 200 + chunked，再周期滴空格保活（见上方机制 2）
  let dripTimer = null, dripBeat = null, dripCommitted = false
  const stopDrip = () => {
    if (dripTimer !== null) { clearTimeout(dripTimer); dripTimer = null }
    if (dripBeat !== null) { clearInterval(dripBeat); dripBeat = null }
  }
  if (isDrip) {
    dripTimer = setTimeout(() => {
      dripTimer = null
      if (res.headersSent || res.writableEnded) return
      dripCommitted = true
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.write(' ')
        if (DRIP_MS > 0) {
          dripBeat = setInterval(() => {
            try { if (!res.writableEnded) res.write(' ') } catch { }
          }, DRIP_MS)
          dripBeat.unref?.()
        }
      } catch { }
    }, DRIP_GRACE_MS)
    dripTimer.unref?.()
  }
  const upHeaders = cleanHeaders(req)
  // drip 路径已按 200 提交、无法再声明 content-encoding，强制上游回 identity
  if (isDrip) delete upHeaders['accept-encoding']
  // 只重放无请求体的导航请求（重放时 body 已被第一次 dispatch 消费掉）
  const canRetry = !isDrip && (req.method === 'GET' || req.method === 'HEAD')

  // 回写上游响应。dsh 的会话 Cookie 不下发给浏览器——它由网关独占（见文件上方说明）
  function relay(upRes) {
    stopDrip()
    const h = { ...upRes.headers }
    if (h['set-cookie'] !== undefined) {
      const kept = [].concat(h['set-cookie']).filter((c) => !String(c).startsWith(DSH_COOKIE_PREFIX))
      if (kept.length > 0) h['set-cookie'] = kept
      else delete h['set-cookie']
    }
    const ct = String(h['content-type'] || '')
    const ce = String(h['content-encoding'] || '')
    const isHtml = ct.includes('text/html') && (!ce || ce === 'identity')
    const mayGzip = !isHtml && clientGzip && upRes.statusCode === 200 &&
      (!ce || ce === 'identity') && GZIP_TYPE.test(ct) && !ct.includes('text/event-stream')
    if (!isHtml && !mayGzip) {
      res.writeHead(upRes.statusCode || 502, h)
      upRes.pipe(res)
      return
    }
    // 缓冲后处理（HTML 注入 / gzip）。超过上限则原样透传（已收字节未改动，content-length 仍有效）
    const chunks = []
    let size = 0, passthrough = false
    upRes.on('data', (c) => {
      if (passthrough) { res.write(c); return }
      chunks.push(c); size += c.length
      if (size > HTML_LIMIT) {
        passthrough = true
        res.writeHead(upRes.statusCode || 502, h)
        for (const pc of chunks) res.write(pc)
        chunks.length = 0
      }
    })
    upRes.on('end', () => {
      if (passthrough) { res.end(); return }
      let body = isHtml
        ? Buffer.from(injectHtml(Buffer.concat(chunks).toString('utf8')), 'utf8')
        : Buffer.concat(chunks)
      // 长度改变：清掉 hop-by-hop 头，重写 content-length（TE 与 CL 并存会被 fetch 拒绝）
      delete h['transfer-encoding']
      delete h['connection']
      delete h['keep-alive']
      if (isHtml) {
        h['cache-control'] = 'no-store' // 仅 HTML；hash 命名的静态资产必须保留浏览器缓存，否则流量反增
      } else if (body.length > GZIP_MIN) {
        body = zlib.gzipSync(body)
        h['content-encoding'] = 'gzip'
        h['vary'] = 'Accept-Encoding'
      }
      h['content-length'] = String(body.length)
      res.writeHead(upRes.statusCode || 502, h)
      res.end(body)
    })
    upRes.on('error', () => { try { res.end() } catch { } })
  }

  function dispatch(headers, replay) {
    const upstream = http.request({
      host: TARGET_HOST, port: TARGET_PORT,
      method: req.method, path: req.url,
      headers,
    }, (upRes) => {
      stopHeartbeat()
      if (dripCommitted) {
        stopDrip()
        // 已按 200 提交：真实状态码无法传达，只能力保正文送达（见上方机制 2 的代价说明）
        if (upRes.statusCode !== 200) {
          console.log(`commands/execute 迟到的 HTTP ${upRes.statusCode} 已无法传达，客户端按 200 收到正文`)
        }
        upRes.pipe(res)
        upRes.on('error', () => { try { res.end() } catch { } })
        return
      }
      // 导航请求被 dsh 401：网关自己也没有可用 Cookie（首次、或缓存被 dsh 拒绝）。现场
      // 换一份再原样重放这次请求——浏览器完全不知情，因此不可能出现重定向环。
      // 重放仍 401 就明说，不再重试。
      if (upRes.statusCode === 401 && isNavRequest(req) && (canRetry || replay)) {
        upRes.resume()
        stopDrip()
        if (!replay) {
          // 本次带上去的就是缓存那份 → 它已被 dsh 拒绝，必须强制重换；否则缓存里已经是
          // 更新的（并发时别的请求刚换过），直接用它重放即可，别重复换
          const cur = freshDshCookie()
          const stale = cur === '' || String(headers.cookie || '').includes(cur)
          mintDshCookie(stale).then((pair) => {
            if (pair === '') { warnNoDshToken(); sendPage(res, 401, NO_SESSION_PAGE); return }
            dispatch(cleanHeaders(req), true)
          }).catch(() => sendPage(res, 401, NO_SESSION_PAGE))
          return
        }
        warnNoDshToken()
        sendPage(res, 401, NO_SESSION_PAGE)
        return
      }
      relay(upRes)
    })
    upstream.on('error', (err) => {
      stopHeartbeat()
      stopDrip()
      if (res.destroyed || res.writableEnded) return // 客户端已放弃，别拿日志刷屏
      console.error('转发失败: ' + (err && err.message))
      try {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Bad Gateway: DSH Web UI 不可达，请确认 dsh web 已启动')
      } catch { }
    })
    res.on('close', () => { stopHeartbeat(); stopDrip(); try { upstream.destroy() } catch { } })
    // 重放没有请求体（只对 GET/HEAD 重放），必须显式 end() 才会发出去
    if (replay) upstream.end()
    else req.pipe(upstream)
    return upstream
  }

  req.on('data', (c) => meterUp(c.length))
  dispatch(upHeaders, false)
}

// ---- 认证 ------------------------------------------------------------------------
function authed(req) {
  return tokenEq(parseCookies(req)[COOKIE_NAME], TOKEN)
}

// ---- server ----------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // 首次登录：?t=<token> → 种 Cookie 并跳回干净 URL
  const ticket = queryTicket(req.url)
  if (ticket !== undefined) {
    if (failLimited()) { sendPage(res, 429, LIMITED_PAGE); return }
    if (!tokenEq(ticket, TOKEN)) { noteFail(); sendPage(res, 403, DENY_PAGE); return }
    const secure = (FORCE_HTTPS || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : ''
    // 顺手预热 dsh 会话 Cookie，下一跳就不用等 401 再换。不 await：换不到也不影响登录。
    mintDshCookie().catch(() => { })
    res.writeHead(302, {
      'Location': '/',
      'Set-Cookie': COOKIE_NAME + '=' + TOKEN + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + secure,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
    res.end('')
    return
  }
  // /pwa/* 静态资产豁免认证：iOS「添加到主屏幕」抓取 apple-touch-icon/manifest 时
  // 不带会话 Cookie，若拦在 401 会导致主屏图标丢失。这些只是图标和清单，无敏感信息。
  if (req.url.startsWith('/pwa/')) { servePwa(req, res); return }
  if (!authed(req)) { sendPage(res, 401, UNAUTH_PAGE); return }
  forward(req, res)
})

// WebSocket 隧道：同样的头清洗，裸 TCP 双通
server.on('upgrade', (req, socket, head) => {
  if (!authed(req)) {
    try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch { }
    return
  }
  const headers = cleanHeaders(req)
  headers['connection'] = 'Upgrade'
  headers['upgrade'] = req.headers.upgrade || 'websocket'
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n'
    for (const k in headers) {
      const v = headers[k]
      if (Array.isArray(v)) { for (const it of v) raw += k + ': ' + it + '\r\n' }
      else raw += k + ': ' + v + '\r\n'
    }
    raw += '\r\n'
    try {
      upstream.write(raw)
      if (head && head.length) upstream.write(head)
      meterReq(String(req.url || '').split('?')[0])
      socket.on('data', (c) => meterUp(c.length)) // WS 帧计数（pipe 之外并行监听，不消费）
      upstream.on('data', (c) => meterDown(String(req.url || '').split('?')[0], c.length))
      socket.pipe(upstream)
      upstream.pipe(socket)
    } catch { kill() }
  })
  const kill = () => { try { socket.destroy() } catch { } try { upstream.destroy() } catch { } }
  socket.on('error', kill); upstream.on('error', kill)
  socket.on('close', kill); upstream.on('close', kill)
})

server.on('error', (err) => {
  // EADDRINUSE 是最常见的启动失败：上一次的网关没退出干净（关掉面板窗口不会停栈；
  // 控制台被异常结束时也可能留下 node 子进程），于是端口一直被占。默认行为是 Node
  // 抛一个 Unhandled 'error' 堆栈，被 start.mjs 当成「意外崩溃」直接团灭，用户只能看到
  // 一屏看不懂的 at Server.setupListenHandle —— 这里换成能照着做的两行，并用退出码 2
  // 让 start.mjs 区分「环境残留」与真正的崩溃。
  if (err && err.code === 'EADDRINUSE') {
    // 不打 `[gate] ` 前缀：由 start.mjs 的日志标签统一加；单独跑 gateway.mjs 时这段文案本身已点明
    console.error(`端口 ${BIND_HOST}:${PORT} 已被占用（多半是上一次的网关还在跑）`)
    console.error(`结束占用者后重试：netstat -ano | findstr :${PORT}   taskkill /PID <PID> /T /F`)
    process.exit(2)
  }
  console.error(`监听 ${BIND_HOST}:${PORT} 失败: ${err && err.message ? err.message : err}`)
  process.exit(1)
})

server.listen(PORT, BIND_HOST, () => {
  console.log(`listening on ${BIND_HOST}:${PORT} -> ${TARGET_HOST}:${TARGET_PORT}`)
  if (BIND_HOST === '0.0.0.0') {
    lanIp().then((ip) => {
      console.log(`登录链接: http://${ip || '<本机局域网IP>'}:${PORT}/?t=${TOKEN}`)
      const alts = lanCandidates().filter((a) => a !== ip && !a.startsWith('169.254.'))
      if (alts.length > 0) console.log(`备用 IP: ${alts.join(' / ')}`)
    })
  } else if (FORCE_HTTPS) {
    // cf 模式：域名由 cloudflared 每次启动随机分配，网关无从得知，登录链接由 start.mjs 抓 URL 后打印
    console.log('登录链接见 [start] 输出（cloudflared 临时域名）')
  } else {
    console.log(`登录链接: https://${DOMAIN || '<你的域名>'}/?t=${TOKEN}`)
  }
})
