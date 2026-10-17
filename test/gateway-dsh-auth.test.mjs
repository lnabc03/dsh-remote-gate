// dsh >= 0.2 自带浏览器会话认证的桥接测试。
//
// 背景：dsh 0.2 起 `dsh web` 自己对 `/` 与 `/api` 认证——没有 `dsh-auth-*` Cookie 一律 401，
// 「把 Host 改写成 127.0.0.1:3080 就等价于本机浏览器」不再成立。
//
// 网关的做法：**会话 Cookie 由网关自己持有**，用启动令牌换一次（缓存 10 分钟）后在转发时
// 换上，浏览器的同名 Cookie 一律丢弃、dsh 回的同名 Set-Cookie 一律不下发。
//
// 曾经的做法（401 → 把浏览器重定向到 /?token=… → dsh 种 Cookie → 303 回 /）在 iPhone 上
// 会无限打转「重定向次数过多」：WebKit 对跨站发起的导航链不送 SameSite=Strict Cookie，
// 而 dsh 只认同名 Cookie 的第一份。所以下面每个用例都断言「没有 Location」。
//
// mock 复刻了 dsh 的真实语义（令牌换 Cookie / Cookie 放行 / 其余 401 / 只认同名第一份）。
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
const GATE_PORT = 37000 + Math.floor(Math.random() * 4000)
const UP_PORT = GATE_PORT + 5001
const TOKEN_FILE = path.join(os.tmpdir(), 'dsh-gate-auth-' + GATE_PORT)

const HTML_PAGE = '<!doctype html><html><head><title>dsh</title>' +
  '<link rel="manifest" href="./manifest.webmanifest" /></head><body>app</body></html>'

// mock 侧状态：accepted = dsh 认可的会话值；清空它等价于 dsh 换了签名密钥
const state = { seq: 0, accepted: new Set(), validToken: 'launch-' + Math.random().toString(36).slice(2), exchanges: [] }

let upstream, gate

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

const cookieHeader = (value) =>
  `dsh-auth-abc=${value}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`

function mockDsh(req, res) {
  const url = new URL(req.url, 'http://dsh.invalid')
  const tok = url.searchParams.get('token')
  if (req.method === 'GET' && url.pathname === '/' && tok !== null) {
    state.exchanges.push(tok)
    if (tok === state.validToken) {
      const value = 'v1.' + (++state.seq)
      state.accepted.add(value)
      res.writeHead(303, { 'Location': './', 'Set-Cookie': cookieHeader(value), 'Referrer-Policy': 'no-referrer' })
      res.end()
      return
    }
    // 令牌不对：与真实 dsh 一致——401，且不种 Cookie
  }
  // 只认同名 Cookie 的第一份（真实 dsh 实测行为）
  const first = /(?:^|;\s*)dsh-auth-abc=([^;]*)/.exec(String(req.headers.cookie || ''))
  if (first && state.accepted.has(first[1])) {
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // dsh 会顺带刷新会话 Cookie；网关必须把它挡在浏览器之外，其余 Set-Cookie 照常透传
      'Set-Cookie': [cookieHeader(first[1]), 'theme=dark; Path=/'],
    })
    res.end(HTML_PAGE)
    return
  }
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
}

function startGateway(port, tokenFile) {
  const proc = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_GATE_TOKEN: TOKEN,
      DSH_GATE_PORT: String(port),
      DSH_GATE_TARGET_PORT: String(UP_PORT),
      DSH_GATE_BIND: '127.0.0.1',
      DSH_GATE_DSH_TOKEN_FILE: tokenFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let out = ''
    proc.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve(proc) })
    proc.stderr.on('data', (d) => { out += d })
    proc.on('exit', (code) => reject(new Error('gateway exited early: ' + code + '\n' + out)))
    setTimeout(() => reject(new Error('gateway listen timeout\n' + out)), 8000)
  })
}

before(async () => {
  upstream = http.createServer(mockDsh)
  await listen(upstream, UP_PORT)
  fs.writeFileSync(TOKEN_FILE, state.validToken + '\n')
  gate = await startGateway(GATE_PORT, TOKEN_FILE)
})

after(() => {
  try { gate.kill() } catch { }
  try { upstream.close() } catch { }
  try { fs.unlinkSync(TOKEN_FILE) } catch { }
})

const base = () => `http://127.0.0.1:${GATE_PORT}`
const NAV = { Accept: 'text/html,application/xhtml+xml' }
const setCookies = (res) => (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [])

async function loginCookie() {
  const res = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  return (res.headers.get('set-cookie') || '').split(';')[0]
}

test('登录 302 到干净的 /：地址栏里不出现 dsh 启动令牌', async () => {
  const res = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/')
  assert.match(res.headers.get('set-cookie'), /^dg_token=/)
})

test('冷启动导航：网关自换 Cookie 后重放，一次就 200（全程无重定向）', async () => {
  const dgCookie = await loginCookie()
  const res = await fetch(base() + '/', { headers: { ...NAV, Cookie: dgCookie }, redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('location'), null, '导航不能靠重定向去换 Cookie')
  const body = await res.text()
  // 注入仍在：manifest 必须排在 dsh 自带的前面
  assert.match(body, /<link rel="manifest" href="\/pwa\/manifest\.json">/)
  assert.ok(body.indexOf('/pwa/manifest.json') < body.indexOf('./manifest.webmanifest'))
})

test('dsh 的会话 Cookie 不下发给浏览器，其它 Set-Cookie 照常透传', async () => {
  const dgCookie = await loginCookie()
  const res = await fetch(base() + '/', { headers: { ...NAV, Cookie: dgCookie } })
  assert.equal(res.status, 200)
  const sc = setCookies(res)
  assert.ok(!sc.some((s) => s.startsWith('dsh-auth-')), 'dsh-auth-* 必须被网关拦下')
  assert.ok(sc.some((s) => s.startsWith('theme=dark')), '非 dsh 的 Cookie 要原样透传')
})

test('浏览器残留同名旧 Cookie 也照样 200（dsh 只认同名第一份）', async () => {
  const dgCookie = await loginCookie()
  // 故意把坏值放在前面：若网关把客户端 Cookie 透传上去，dsh 会 401
  const res = await fetch(base() + '/', { headers: { ...NAV, Cookie: `dsh-auth-abc=v1.garbage; ${dgCookie}` } })
  assert.equal(res.status, 200)
})

test('缓存被 dsh 拒绝（换了签名密钥）→ 强制重换一次并恢复', async () => {
  const dgCookie = await loginCookie()
  assert.equal((await fetch(base() + '/', { headers: { ...NAV, Cookie: dgCookie } })).status, 200)
  state.accepted.clear() // 模拟 dsh 侧签名密钥变化：缓存那份失效
  const after = await fetch(base() + '/', { headers: { ...NAV, Cookie: dgCookie }, redirect: 'manual' })
  assert.equal(after.status, 200, '缓存失效后应自动重换，而不是把 401 甩给用户')
  assert.equal(after.headers.get('location'), null)
})

test('dsh 重启换了启动令牌：网关按 mtime 懒读新值，无需重启网关', async () => {
  const dgCookie = await loginCookie()
  state.accepted.clear()
  state.validToken = 'launch-rotated-' + Math.random().toString(36).slice(2)
  fs.writeFileSync(TOKEN_FILE, state.validToken + '\n')
  const future = new Date(Date.now() + 4000) // 部分文件系统 mtime 粒度 1s，且网关侧有 1s stat 节流
  fs.utimesSync(TOKEN_FILE, future, future)
  await new Promise((r) => setTimeout(r, 1200))
  const before = state.exchanges.length
  const res = await fetch(base() + '/', { headers: { ...NAV, Cookie: dgCookie }, redirect: 'manual' })
  assert.equal(res.status, 200)
  assert.equal(state.exchanges.length - before, 1, '只需换一次')
  assert.equal(state.exchanges.at(-1), state.validToken, '必须用文件里的新令牌')
})

test('并发冷启动：多个导航同时 401 只换一次 Cookie', async () => {
  const dgCookie = await loginCookie()
  state.accepted.clear()
  const before = state.exchanges.length
  const all = await Promise.all([1, 2, 3, 4, 5].map(
    () => fetch(base() + '/', { headers: { ...NAV, Cookie: dgCookie } })))
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200, 200])
  assert.equal(state.exchanges.length - before, 1)
})

test('XHR（非导航）401 不注入页面、不重定向——前端要的是状态码', async () => {
  const dgCookie = await loginCookie()
  state.accepted.clear()
  state.validToken = '' // 换不到 Cookie
  const res = await fetch(base() + '/api/anything', {
    headers: { Cookie: dgCookie, Accept: 'application/json' },
    redirect: 'manual',
  })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('location'), null)
  assert.match(await res.text(), /authentication required/)
  state.validToken = 'launch-' + Math.random().toString(36).slice(2)
})

test('拿不到启动令牌（外部启动的 dsh）→ 明确页面，而不是重定向环', async () => {
  const port = GATE_PORT + 777
  const other = await startGateway(port, path.join(os.tmpdir(), 'dsh-gate-absent-' + port))
  try {
    const b = `http://127.0.0.1:${port}`
    const login = await fetch(b + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
    assert.equal(login.headers.get('location'), '/')
    const dgCookie = (login.headers.get('set-cookie') || '').split(';')[0]
    const res = await fetch(b + '/', { headers: { ...NAV, Cookie: dgCookie }, redirect: 'manual' })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('location'), null)
    assert.match(await res.text(), /令牌缺失或已失效/)
  } finally {
    try { other.kill() } catch { }
  }
})
