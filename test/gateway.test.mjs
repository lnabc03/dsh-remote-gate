// dsh-mobile-mini 冒烟测试：起 mock 上游 + 网关子进程，验证认证、头清洗、HTML 注入、/pwa 资产
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY = path.join(__dirname, '..', 'gateway.mjs')

const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
const GATE_PORT = 31000 + Math.floor(Math.random() * 5000)
const UP_PORT = GATE_PORT + 5001

const HTML_PAGE = '<!doctype html><html><head><title>dsh</title><link rel="manifest" href="/manifest.webmanifest" /></head><body>hello</body></html>'

let upstream, gate, lastUpstreamHeaders

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

before(async () => {
  upstream = http.createServer((req, res) => {
    lastUpstreamHeaders = req.headers
    if (req.url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML_PAGE)
  })
  await listen(upstream, UP_PORT)

  gate = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_GATE_TOKEN: TOKEN,
      DSH_GATE_PORT: String(GATE_PORT),
      DSH_GATE_TARGET_PORT: String(UP_PORT),
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
})

const base = () => `http://127.0.0.1:${GATE_PORT}`

test('无 Cookie 访问 → 401', async () => {
  const res = await fetch(base() + '/', { redirect: 'manual' })
  assert.equal(res.status, 401)
  const body = await res.text()
  assert.match(body, /未授权|令牌/)
})

test('错误令牌 → 403', async () => {
  const res = await fetch(base() + '/?t=wrong-token', { redirect: 'manual' })
  assert.equal(res.status, 403)
})

test('正确令牌 → 302 + Set-Cookie', async () => {
  const res = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  assert.equal(res.status, 302)
  const cookie = res.headers.get('set-cookie') || ''
  assert.match(cookie, new RegExp('dg_token=' + TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(cookie, /HttpOnly/)
  assert.equal(res.headers.get('location'), '/')
})

async function loginCookie() {
  const res = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  return (res.headers.get('set-cookie') || '').split(';')[0]
}

test('带 Cookie 访问 → 代理成功且注入 manifest', async () => {
  const cookie = await loginCookie()
  const res = await fetch(base() + '/', { headers: { Cookie: cookie } })
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /<link rel="manifest" href="\/pwa\/manifest\.json">/)
  assert.match(body, /apple-touch-icon/)
  assert.match(body, /serviceWorker\.register/)
  // 我们的 manifest 必须排在 dsh 自带的 /manifest.webmanifest 之前（先到先得）
  assert.ok(body.indexOf('/pwa/manifest.json') < body.indexOf('/manifest.webmanifest'),
    '注入的 manifest 链接必须出现在 dsh 自带 manifest 之前')
  assert.match(body, /<\/head><body>hello<\/body>/)
})

test('上游看到的头：host 重写、无 x-forwarded-*、无 origin、无网关 Cookie', async () => {
  const cookie = await loginCookie()
  const res = await fetch(base() + '/api/data', {
    headers: {
      Cookie: cookie,
      Origin: 'https://dsh.example.com',
      'X-Forwarded-For': '1.2.3.4',
      'X-Forwarded-Host': 'dsh.example.com',
    },
  })
  assert.equal(res.status, 200)
  assert.equal(lastUpstreamHeaders.host, `127.0.0.1:${UP_PORT}`)
  for (const k of Object.keys(lastUpstreamHeaders)) {
    assert.ok(!k.startsWith('x-forwarded'), '上游不应收到 ' + k)
  }
  assert.ok(!('origin' in lastUpstreamHeaders))
  assert.ok(!('x-real-ip' in lastUpstreamHeaders))
  assert.ok(!String(lastUpstreamHeaders.cookie || '').includes('dg_token'), '网关 Cookie 不应泄露给上游')
})

test('非 HTML 响应原样透传', async () => {
  const cookie = await loginCookie()
  const res = await fetch(base() + '/api/data', { headers: { Cookie: cookie } })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '{"ok":true}')
})

test('/pwa/* 豁免认证（iOS 安装图标不带 Cookie），其余路径仍拦 401', async () => {
  const anon = await fetch(base() + '/pwa/manifest.json')
  assert.equal(anon.status, 200)
  const manifest = await anon.json()
  assert.equal(manifest.display, 'standalone')
  const icon = await fetch(base() + '/pwa/icons/icon-192.png')
  assert.equal(icon.status, 200)
  const sw = await fetch(base() + '/pwa/sw.js')
  assert.equal(sw.status, 200)
  assert.equal(sw.headers.get('service-worker-allowed'), '/')
  const authedPage = await fetch(base() + '/')
  assert.equal(authedPage.status, 401)
})

test('/pwa 路径穿越被拒绝', async () => {
  const cookie = await loginCookie()
  const res = await fetch(base() + '/pwa/..%2Fgateway.mjs', { headers: { Cookie: cookie } })
  assert.equal(res.status, 404)
})
