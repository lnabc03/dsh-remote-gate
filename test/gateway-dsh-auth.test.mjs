// dsh >= 0.2 自带浏览器会话认证的桥接测试。
//
// 背景：dsh 0.2 起 `dsh web` 自己对 `/` 与 `/api` 认证——没有 `dsh-auth-*` Cookie 一律 401，
// 「把 Host 改写成 127.0.0.1:3080 就等价于本机浏览器」不再成立。网关的桥接方式是：导航请求
// 被 401 时，把浏览器引到带一次性启动令牌的根路径，由 dsh 种 Cookie 后 303 回应用。
//
// mock 上游复刻了 dsh 的真实语义（令牌换 Cookie / Cookie 放行 / 其余 401），因此这里跑的是
// 「远端设备首次登录」的完整链路，而不只是单个响应码。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY = path.join(__dirname, '..', 'gateway.mjs')

const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
const DSH_TOKEN = 'launch-' + Math.random().toString(36).slice(2)
const GATE_PORT = 37000 + Math.floor(Math.random() * 4000)
const UP_PORT = GATE_PORT + 5001
const TOKEN_FILE = path.join(os.tmpdir(), 'dsh-gate-auth-' + GATE_PORT)

const HTML_PAGE = '<!doctype html><html><head><title>dsh</title>' +
  '<link rel="manifest" href="./manifest.webmanifest" /></head><body>app</body></html>'

let upstream, gate

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

// 复刻 dsh 0.2 的认证语义：
//   GET /?token=<启动令牌>      → 303 ./ + Set-Cookie dsh-auth-*（一次性交换）
//   带 dsh-auth-* Cookie 的请求 → 200
//   其余                        → 401 "dsh web authentication required"
function mockDsh(req, res) {
  const url = new URL(req.url, 'http://dsh.invalid')
  const hasCookie = /(?:^|;\s*)dsh-auth-/.test(String(req.headers.cookie || ''))
  if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === DSH_TOKEN) {
    res.writeHead(303, {
      'Location': './',
      'Set-Cookie': 'dsh-auth-abc=v1.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict',
      'Referrer-Policy': 'no-referrer',
    })
    res.end()
    return
  }
  if (hasCookie) {
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML_PAGE)
    return
  }
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
}

before(async () => {
  upstream = http.createServer(mockDsh)
  await listen(upstream, UP_PORT)
  fs.writeFileSync(TOKEN_FILE, DSH_TOKEN + '\n')

  gate = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_GATE_TOKEN: TOKEN,
      DSH_GATE_PORT: String(GATE_PORT),
      DSH_GATE_TARGET_PORT: String(UP_PORT),
      DSH_GATE_BIND: '127.0.0.1',
      DSH_GATE_DSH_TOKEN_FILE: TOKEN_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  await new Promise((resolve, reject) => {
    gate.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve() })
    gate.stderr.on('data', (d) => { out += d })
    gate.on('exit', (code) => reject(new Error('gateway exited early: ' + code + '\n' + out)))
    setTimeout(() => reject(new Error('gateway listen timeout\n' + out)), 8000)
  })
})

after(() => {
  try { gate.kill() } catch { }
  try { upstream.close() } catch { }
  try { fs.unlinkSync(TOKEN_FILE) } catch { }
})

const base = () => `http://127.0.0.1:${GATE_PORT}`
const NAV = { Accept: 'text/html,application/xhtml+xml' }

test('登录 302 的 Location 直接带上 dsh 启动令牌（省掉一次 401 往返）', async () => {
  const res = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/?token=' + DSH_TOKEN)
  // 令牌出现在这一跳的 URL 里，禁止外泄给任何第三方
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
})

test('完整链路：登录 → 令牌换 Cookie → 应用可用（manifest 仍被注入）', async () => {
  // 1) 网关登录，拿 dg_token，并被引向带 dsh 令牌的根路径
  const login = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  const dgCookie = (login.headers.get('set-cookie') || '').split(';')[0]
  assert.match(dgCookie, /^dg_token=/)
  const mintUrl = login.headers.get('location')
  assert.equal(mintUrl, '/?token=' + DSH_TOKEN)

  // 2) 用 dg_token 打开带令牌的根路径 → dsh 种 Cookie 并 303 回 ./
  const mint = await fetch(base() + mintUrl, { headers: { ...NAV, Cookie: dgCookie }, redirect: 'manual' })
  assert.equal(mint.status, 303)
  assert.equal(mint.headers.get('location'), './')
  const dshCookie = (mint.headers.get('set-cookie') || '').split(';')[0]
  assert.match(dshCookie, /^dsh-auth-/, 'dsh 的 Set-Cookie 必须原样穿过网关')

  // 3) 带两个 Cookie 访问应用 → 200 + 网关注入的 manifest 排在 dsh 自带的前面
  const app = await fetch(base() + '/', { headers: { ...NAV, Cookie: `${dgCookie}; ${dshCookie}` } })
  assert.equal(app.status, 200)
  const body = await app.text()
  assert.match(body, /<link rel="manifest" href="\/pwa\/manifest\.json">/)
  assert.ok(body.indexOf('/pwa/manifest.json') < body.indexOf('./manifest.webmanifest'))
})

test('无 Cookie 的导航请求被 dsh 401 → 网关重定向去换 Cookie（而不是把 401 甩给用户）', async () => {
  const dgCookie = (await loginCookie())
  const res = await fetch(base() + '/', {
    headers: { ...NAV, Cookie: dgCookie },
    redirect: 'manual',
  })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/?token=' + DSH_TOKEN)
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
})

test('已带 token= 仍被 401（令牌失效）→ 原样透传 401，不再重定向（防重定向环）', async () => {
  const dgCookie = await loginCookie()
  const res = await fetch(base() + '/?token=stale-token', {
    headers: { ...NAV, Cookie: dgCookie },
    redirect: 'manual',
  })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('location'), null)
  assert.match(await res.text(), /authentication required/)
})

test('非导航请求（XHR/fetch）401 不重定向——前端要的是状态码，不是一段 HTML', async () => {
  const dgCookie = await loginCookie()
  const res = await fetch(base() + '/api/anything', {
    headers: { Cookie: dgCookie, Accept: 'application/json' },
    redirect: 'manual',
  })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('location'), null)
})

test('dsh 重启换了启动令牌：网关按 mtime 懒读新值，无需重启网关', async () => {
  const next = 'launch-rotated-' + Math.random().toString(36).slice(2)
  fs.writeFileSync(TOKEN_FILE, next + '\n')
  // 让 mtime 明确变化（部分文件系统 mtime 粒度 1s，且网关侧有 1s stat 节流）
  const future = new Date(Date.now() + 4000)
  fs.utimesSync(TOKEN_FILE, future, future)
  await new Promise((r) => setTimeout(r, 1200))
  const res = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/?token=' + next)
})

test('令牌文件缺失（外部启动的 dsh）→ 退回旧的 401 透传行为，不重定向', async () => {
  // 独立网关实例：指向一个不存在的令牌文件，验证「拿不到令牌」时的降级路径
  const port = GATE_PORT + 777
  const other = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_GATE_TOKEN: TOKEN,
      DSH_GATE_PORT: String(port),
      DSH_GATE_TARGET_PORT: String(UP_PORT),
      DSH_GATE_BIND: '127.0.0.1',
      DSH_GATE_DSH_TOKEN_FILE: path.join(os.tmpdir(), 'dsh-gate-absent-' + port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    let out = ''
    await new Promise((resolve, reject) => {
      other.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve() })
      other.stderr.on('data', (d) => { out += d })
      other.on('exit', (code) => reject(new Error('gateway exited early: ' + code + '\n' + out)))
      setTimeout(() => reject(new Error('gateway listen timeout\n' + out)), 8000)
    })
    const b = `http://127.0.0.1:${port}`
    // 登录 Location 退回干净的 `/`
    const login = await fetch(b + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
    assert.equal(login.headers.get('location'), '/')
    const dgCookie = (login.headers.get('set-cookie') || '').split(';')[0]
    // 导航 401 原样透传
    const res = await fetch(b + '/', { headers: { ...NAV, Cookie: dgCookie }, redirect: 'manual' })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('location'), null)
  } finally {
    try { other.kill() } catch { }
  }
})

async function loginCookie() {
  const res = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  return (res.headers.get('set-cookie') || '').split(';')[0]
}
