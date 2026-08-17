// dsh-remote-gate 冒烟测试：起 mock 上游 + 网关子进程，验证认证、头清洗、HTML 注入、/pwa 资产
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY = path.join(__dirname, '..', 'gateway.mjs')

const TOKEN = 'test-token-' + Math.random().toString(36).slice(2)
const GATE_PORT = 31000 + Math.floor(Math.random() * 5000)
const UP_PORT = GATE_PORT + 5001

const HTML_PAGE = '<!doctype html><html><head><title>dsh</title><link rel="manifest" href="/manifest.webmanifest" /></head><body>hello</body></html>'
const BIG_JS = 'console.log("' + 'x'.repeat(200 * 1024) + '")\n' // >1KB 可压资产
const SSE_BODY = 'data: hello\n\n'.repeat(100) // >1KB 流式响应（验证不被压缩）

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
    if (req.url === '/assets/big.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      res.end(BIG_JS)
      return
    }
    if (req.url === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(SSE_BODY)
      return
    }
    if (req.url === '/api/slow') {
      // 模拟 compact 类同步长命令：响应头 600ms 后才给出
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"slow":true}')
      }, 600)
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
      // 固定绑 127.0.0.1：否则网关会读仓库里真实 config.json 的 mode（用户当前可能是 lan），测试不再密封
      DSH_GATE_BIND: '127.0.0.1',
      // 加速心跳便于测试 102 Processing（生产默认 25s）
      DSH_GATE_HEARTBEAT_MS: '80',
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
  // 非 lan（127.0.0.1 / HTTPS 拓扑）不注入 randomUUID polyfill——安全上下文原生就有
  assert.ok(!body.includes('randomUUID'), 'frp/ssh 模式不应注入 randomUUID polyfill')
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

test('accept-encoding：导航请求（Accept 含 text/html）摘除，其余保留（隧道流量大头）', async () => {
  const cookie = await loginCookie()
  // API：fetch 默认 Accept: */* → 保留压缩协商
  await fetch(base() + '/api/data', { headers: { Cookie: cookie } })
  assert.ok('accept-encoding' in lastUpstreamHeaders, '非导航请求应保留 accept-encoding')
  // 导航：可能返回 HTML 需要注入 → 摘除，强制未压缩
  await fetch(base() + '/', { headers: { Cookie: cookie, Accept: 'text/html,application/xhtml+xml,*/*' } })
  assert.ok(!('accept-encoding' in lastUpstreamHeaders), '导航请求应摘除 accept-encoding')
})

// 裸 http.get（undici fetch 会自动解压/改头，测压缩必须看线上字节）
function rawGet(p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: GATE_PORT, path: p, headers }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, raw: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

test('网关侧 gzip：可压类型 + 客户端接受 → gzip 且解压后内容不变', async () => {
  const cookie = await loginCookie()
  const res = await rawGet('/assets/big.js', { Cookie: cookie, 'Accept-Encoding': 'gzip, br' })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-encoding'], 'gzip')
  assert.ok(res.raw.length < BIG_JS.length / 2, 'gzip 应显著减小体积')
  assert.equal(zlib.gunzipSync(res.raw).toString('utf8'), BIG_JS)
})

test('gzip 豁免：小响应不压、流式（event-stream）不压、客户端不接受时不压', async () => {
  const cookie = await loginCookie()
  const small = await rawGet('/api/data', { Cookie: cookie, 'Accept-Encoding': 'gzip' })
  assert.equal(small.headers['content-encoding'], undefined)
  assert.equal(small.raw.toString(), '{"ok":true}')
  const sse = await rawGet('/api/stream', { Cookie: cookie, 'Accept-Encoding': 'gzip' })
  assert.equal(sse.headers['content-encoding'], undefined)
  assert.equal(sse.raw.toString(), SSE_BODY)
  const noAe = await rawGet('/assets/big.js', { Cookie: cookie })
  assert.equal(noAe.headers['content-encoding'], undefined)
  assert.equal(noAe.raw.toString(), BIG_JS)
})

test('非 HTML 响应原样透传', async () => {
  const cookie = await loginCookie()
  const res = await fetch(base() + '/api/data', { headers: { Cookie: cookie } })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '{"ok":true}')
})

// 裸 TCP 读线上字节：undici/http.get 会吞掉 1xx 中间响应，测心跳必须看原始流
test('长响应保活：等上游响应头期间周期性下发 102 Processing，最终响应完好', async () => {
  const cookie = await loginCookie()
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(GATE_PORT, '127.0.0.1', () => {
      sock.write('POST /api/slow HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Cookie: ' + cookie + '\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 2\r\n' +
        'Connection: close\r\n\r\n{}')
    })
    let buf = ''
    sock.on('data', (d) => { buf += d.toString('latin1') })
    sock.on('end', () => resolve(buf))
    sock.on('error', reject)
    setTimeout(() => reject(new Error('slow request timeout')), 8000)
  })
  // 600ms 延迟 / 80ms 心跳 → 应出现多个 102，且都在最终 200 之前
  const interim = reply.match(/HTTP\/1\.1 102 Processing/g) || []
  assert.ok(interim.length >= 2, `应有多个 102 中间响应，实际 ${interim.length} 个`)
  assert.ok(reply.indexOf('102 Processing') < reply.lastIndexOf('200 OK'), '102 必须在最终响应之前')
  assert.match(reply, /\{"slow":true\}/)
})

test('快响应不触发 102 心跳（普通 API 请求无中间响应）', async () => {
  const cookie = await loginCookie()
  const res = await rawGet('/api/data', { Cookie: cookie })
  assert.equal(res.status, 200)
  assert.equal(res.raw.toString(), '{"ok":true}')
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

test('cf 模式：无 X-Forwarded-Proto 也强制 Secure Cookie（CF 入口恒定 HTTPS，该头不可靠）', async () => {
  const tmp = path.join(os.tmpdir(), 'dsh-gate-cf-' + Math.random().toString(36).slice(2) + '.json')
  const cfPort = 31000 + Math.floor(Math.random() * 5000)
  fs.writeFileSync(tmp, JSON.stringify({ mode: 'cf' }))
  const gate = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_GATE_CONFIG: tmp,
      DSH_GATE_TOKEN: TOKEN,
      DSH_GATE_PORT: String(cfPort),
      DSH_GATE_TARGET_PORT: String(UP_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  try {
    await new Promise((resolve, reject) => {
      gate.stdout.on('data', (d) => { out += d; if (out.includes('listening') && out.includes('cloudflared')) resolve() })
      gate.stderr.on('data', (d) => { out += d })
      gate.on('exit', (code) => reject(new Error('gateway exited early: ' + code + '\n' + out)))
      setTimeout(() => reject(new Error('gateway listen timeout\n' + out)), 8000)
    })
    // cf 模式网关自己不知道临时域名，应提示看 start 输出而不是瞎猜域名
    assert.match(out, /cloudflared/)
    const res = await fetch(`http://127.0.0.1:${cfPort}/?t=` + encodeURIComponent(TOKEN), { redirect: 'manual' })
    assert.equal(res.status, 302)
    const cookie = res.headers.get('set-cookie') || ''
    assert.match(cookie, /Secure/)
  } finally {
    try { gate.kill() } catch { }
    try { fs.unlinkSync(tmp) } catch { }
  }
})
test('lan 模式：网关绑 0.0.0.0 并打印局域网登录链接', async () => {
  const tmp = path.join(os.tmpdir(), 'dsh-gate-lan-' + Math.random().toString(36).slice(2) + '.json')
  const lanPort = 31000 + Math.floor(Math.random() * 5000)
  fs.writeFileSync(tmp, JSON.stringify({ mode: 'lan' }))
  const gate = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_GATE_CONFIG: tmp,
      DSH_GATE_TOKEN: TOKEN,
      DSH_GATE_PORT: String(lanPort),
      DSH_GATE_TARGET_PORT: String(UP_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  try {
    await new Promise((resolve, reject) => {
      gate.stdout.on('data', (d) => { out += d; if (out.includes('listening') && out.includes('http://')) resolve() })
      gate.stderr.on('data', (d) => { out += d })
      gate.on('exit', (code) => reject(new Error('gateway exited early: ' + code + '\n' + out)))
      setTimeout(() => reject(new Error('gateway listen timeout\n' + out)), 8000)
    })
    assert.match(out, /listening on 0\.0\.0\.0:/)
    assert.match(out, /http:\/\//)

    // lan 模式注入的 HTML 必须带 crypto.randomUUID polyfill
    //（明文 HTTP 非安全上下文，浏览器原生没有它，dsh 前端会抛错）
    const login = await fetch(`http://127.0.0.1:${lanPort}/?t=` + encodeURIComponent(TOKEN), { redirect: 'manual' })
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    const res = await fetch(`http://127.0.0.1:${lanPort}/`, { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /crypto\.randomUUID=function/)
    assert.match(body, /getRandomValues/)
  } finally {
    try { gate.kill() } catch { }
    try { fs.unlinkSync(tmp) } catch { }
  }
})
