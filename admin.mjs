// admin.mjs — 本地控制面板 HTTP 服务（start.mjs 的可视化替代）
//
// 边界与安全模型：
//   - 只绑 127.0.0.1，手机/局域网/公网都够不到（面板 = 本机控制台，不是远程功能）
//   - 鉴权复用 config.json 的网关令牌：启动器自动打开的 URL 带 ?t=，命中后种 dg_admin Cookie
//     （HttpOnly + SameSite=Strict，localhost 明文 http 故不加 Secure）
//   - 所有 POST 额外要求 X-DG-Admin 自定义头——跨站表单/fetch 无法带自定义头过 CORS 预检，
//     本机恶意网页因此无法静默改配置（CSRF 防护；面板拿得到的是真令牌，别网页拿不到）
//   - 不引入任何基于 IP 的请求逻辑（约束 1）；127.0.0.1 绑址是 OS 层边界，不是请求判断

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ADMIN_DIR = path.join(__dirname, 'admin')
const COOKIE_NAME = 'dg_admin'
const LOG_BUFFER_MAX = 300
const BODY_LIMIT = 64 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

// 允许服务的静态文件白名单（路径穿越防护之外的第二道：面板资产是闭集）
const STATIC_FILES = new Set([
  '/index.html', '/app.js', '/style.css',
  '/vendor/qrcode.js', '/vendor/whale.svg',
  '/vendor/fonts/inter-latin.woff2', '/vendor/fonts/jetbrains-mono-latin.woff2',
])

function tokenEq(a, b) {
  const ba = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb)
}

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

function queryTicket(url) {
  const q = String(url || '').indexOf('?')
  if (q < 0) return undefined
  const m = url.slice(q + 1).match(/(?:^|&)t=([^&]*)/)
  return m ? decodeURIComponent(m[1]) : undefined
}

const UNAUTH_PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>未授权</title>' +
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
  'background:#0b0c0f;color:#e7e9ee;font:16px/1.6 system-ui,sans-serif}' +
  '.card{max-width:22rem;padding:2rem;text-align:center}.muted{color:#9aa1ad;font-size:.9em}</style>' +
  '</head><body><div class="card"><h2>DSH Remote Gate 控制面板</h2>' +
  '<p class="muted">面板仅能从本机启动器打开。<br>若令牌已轮换，请回到启动器窗口复制新链接，或重新运行 <code>npm start</code>。</p>' +
  '</div></body></html>'

// 子进程输出常带 ANSI 颜色转义（frpc/cloudflared），面板日志是纯文本，进缓冲前剥掉
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g

// actions: { getStatus(), getConfig(), saveConfig(payload), restartDsh() }
// getToken: 函数而非定值——令牌轮换后面板用新令牌继续鉴权
export function startPanel({ getToken, actions, preferredPort = 3089 }) {
  const logBuffer = []
  const sseClients = new Set()

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
      try { res.write(frame) } catch { sseClients.delete(res) }
    }
  }

  const panel = {
    port: 0,
    url: '',
    server: null,
    // start.mjs 的每条日志经此进环形缓冲 + SSE（剥 ANSI 转义，面板是纯文本渲染）
    log(tag, line) {
      const entry = { tag, line: String(line).replace(ANSI_RE, ''), ts: Date.now() }
      logBuffer.push(entry)
      if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
      broadcast('log', entry)
    },
    // 子进程状态/登录链接变化时推送，客户端收到后重新拉 /api/status
    broadcastStatus() {
      try { broadcast('status', actions.getStatus()) } catch { }
    },
    close() {
      for (const res of sseClients) { try { res.end() } catch { } }
      sseClients.clear()
      try { this.server?.close() } catch { }
    },
  }

  function sendJson(res, status, obj, extraHeaders = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    })
    res.end(JSON.stringify(obj))
  }

  function authed(req) {
    return tokenEq(parseCookies(req)[COOKIE_NAME], getToken())
  }

  function serveStatic(req, res, rel) {
    if (!STATIC_FILES.has(rel)) { res.writeHead(404); res.end('Not Found'); return }
    const file = path.join(ADMIN_DIR, rel)
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return }
      const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }
      if (rel === '/index.html') {
        headers['Content-Security-Policy'] = "default-src 'self'"
      }
      res.writeHead(200, headers)
      res.end(data)
    })
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
        catch { reject(new Error('invalid json')) }
      })
      req.on('error', reject)
    })
  }

  const server = http.createServer(async (req, res) => {
    const url = String(req.url || '/')
    const pathname = url.split('?')[0]

    // 登录：?t=<网关令牌> → 种 Cookie 跳回干净 URL（与网关同一令牌，面板不引入第二套凭证）
    const ticket = queryTicket(url)
    if (ticket !== undefined) {
      if (!tokenEq(ticket, getToken())) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(UNAUTH_PAGE)
        return
      }
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': `${COOKIE_NAME}=${getToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        'Cache-Control': 'no-store',
      })
      res.end('')
      return
    }

    if (!authed(req)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(UNAUTH_PAGE)
      return
    }

    // 静态页面与资产（index 之外的入口统一重定向到 /）
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      serveStatic(req, res, '/index.html'); return
    }
    if (req.method === 'GET' && STATIC_FILES.has(pathname)) {
      serveStatic(req, res, pathname); return
    }

    // API
    if (pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, actions.getStatus()); return
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, actions.getConfig()); return
    }
    if (pathname === '/api/logs' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      })
      res.write(': ok\n\n')
      for (const entry of logBuffer) {
        res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`)
      }
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    // 写操作：自定义头防线（跨站请求过不了 CORS 预检，带不了这个头）
    if (req.method === 'POST' && (pathname === '/api/config' || pathname === '/api/restart-dsh')) {
      if (req.headers['x-dg-admin'] !== '1') {
        sendJson(res, 403, { ok: false, errors: { _: '缺少防 CSRF 头' } })
        return
      }
      if (pathname === '/api/restart-dsh') {
        const r = await actions.restartDsh()
        sendJson(res, r.ok ? 200 : 500, r)
        return
      }
      let payload
      try { payload = await readBody(req) }
      catch { sendJson(res, 400, { ok: false, errors: { _: '请求体不是合法 JSON' } }); return }
      const r = await actions.saveConfig(payload)
      // 令牌被轮换：面板 Cookie 同步换新，否则面板把自己锁在外面
      const extra = r.ok && r.newToken
        ? { 'Set-Cookie': `${COOKIE_NAME}=${r.newToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` }
        : {}
      sendJson(res, r.ok ? 200 : 400, r, extra)
      return
    }

    sendJson(res, 404, { ok: false, errors: { _: 'Not Found' } })
  })

  // 心跳：防代理/浏览器空闲断线（本地其实不会，但成本为零）
  const heartbeat = setInterval(() => {
    for (const res of sseClients) { try { res.write(': hb\n\n') } catch { sseClients.delete(res) } }
  }, 25_000)
  heartbeat.unref()

  return new Promise((resolve, reject) => {
    const tryListen = (port, attemptsLeft) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryListen(port + 1, attemptsLeft - 1)
        else reject(err)
      })
      server.listen(port, '127.0.0.1', () => {
        panel.server = server
        panel.port = server.address().port // 兼容 preferredPort=0（OS 分配空闲端口，测试用）
        panel.url = `http://127.0.0.1:${panel.port}/?t=${getToken()}`
        resolve(panel)
      })
    }
    tryListen(preferredPort, 10)
  })
}
