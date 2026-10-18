// 内联图片外链化：/plugins/ 下的客户端 bundle 会被网关把大块 data:image base64 换成
// /dg-asset/<hash>.<ext>，由网关自己发（immutable）。这是移动端首屏字节的主战场：
// 实测 dsh 的一条 bundle 里有 4.87MB base64 截图，gzip 几乎压不动。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY = path.join(__dirname, '..', 'gateway.mjs')

const TOKEN = 'asset-token-' + Math.random().toString(36).slice(2)
const GATE_PORT = 41000 + Math.floor(Math.random() * 3000)
const UP_PORT = GATE_PORT + 4001
const ASSET_DIR = path.join(os.tmpdir(), 'dsh-gate-assets-' + GATE_PORT)

// 伪造一张「PNG」：只要字节够大，内容不重要（网关按字节哈希命名）
const BIG = Buffer.alloc(2400)
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 37) % 251
const SMALL = Buffer.alloc(64, 7)
const BIG_B64 = BIG.toString('base64')
const SMALL_B64 = SMALL.toString('base64')
// 尾部的填充保证「改写后」的 bundle 仍超过 gzip 阈值（1024B），否则测不出压缩
const PAD = 'const pad = "' + Math.random().toString(36).repeat(200).slice(0, 3000) + '";\n'

const JS_BODY = 'export const big = "data:image/png;base64,' + BIG_B64 + '";\n' +
  'export const small = "data:image/png;base64,' + SMALL_B64 + '";\n' +
  'export const tail = "keep-me";\n' + PAD

const seen = [] // mock 收到的请求头快照

let upstream, gate

const listen = (s, p) => new Promise((ok, no) => { s.once('error', no); s.listen(p, '127.0.0.1', ok) })

function mockDsh(req, res) {
  seen.push({ url: req.url, ae: req.headers['accept-encoding'] || '', host: req.headers.host })
  if (req.url.startsWith('/plugins/')) {
    // 真实的 dsh 在客户端不给 accept-encoding 时回未压缩的 bundle
    if (req.url.includes('gzipped=1')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Encoding': 'gzip' })
      res.end(zlib.gzipSync(JS_BODY))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' })
    res.end(JS_BODY)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
  res.end(JS_BODY)
}

function startGateway() {
  const proc = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_GATE_TOKEN: TOKEN,
      DSH_GATE_PORT: String(GATE_PORT),
      DSH_GATE_TARGET_PORT: String(UP_PORT),
      DSH_GATE_BIND: '127.0.0.1',
      DSH_GATE_DSH_TOKEN: 'irrelevant',
      DSH_GATE_ASSET_DIR: ASSET_DIR,
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
  gate = await startGateway()
})

after(() => {
  try { gate.kill() } catch { }
  try { upstream.close() } catch { }
  try { fs.rmSync(ASSET_DIR, { recursive: true, force: true }) } catch { }
})

const base = () => `http://127.0.0.1:${GATE_PORT}`
const auth = { Cookie: 'dg_token=' + TOKEN }

// 用裸 http 请求：undici 的 fetch 会自动解压并把 content-encoding 抹掉，测不出网关是否压缩
function rawGet(path, extra = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: GATE_PORT, path, headers: { ...auth, ...extra } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

test('bundle 里的大块 base64 被换成 /dg-asset/，小图标保持内联', async () => {
  const res = await fetch(base() + '/plugins/??pkg/client.js&rev=abc', { headers: auth })
  assert.equal(res.status, 200)
  const body = await res.text()
  const m = /\/dg-asset\/([0-9a-f]{16})\.png/.exec(body)
  assert.ok(m, '大图应该被外链化：' + body.slice(0, 120))
  assert.ok(!body.includes(BIG_B64), '大块 base64 不应再出现在 bundle 里')
  assert.ok(body.includes(SMALL_B64), '小图标不值得多一次往返，保持内联')
  assert.ok(body.includes('keep-me'), '其余内容必须原样保留')
  assert.match(res.headers.get('cache-control') || '', /max-age=86400/)
})

test('外链出来的图片：鉴权后可取，字节与原 base64 一致，immutable', async () => {
  const res = await fetch(base() + '/plugins/??pkg/client.js&rev=abc', { headers: auth })
  const id = /\/dg-asset\/([0-9a-f]{16})\.png/.exec(await res.text())[1]
  const img = await fetch(base() + '/dg-asset/' + id + '.png', { headers: auth })
  assert.equal(img.status, 200)
  assert.equal(img.headers.get('content-type'), 'image/png')
  assert.match(img.headers.get('cache-control') || '', /immutable/)
  const bytes = Buffer.from(await img.arrayBuffer())
  assert.equal(bytes.length, BIG.length)
  assert.ok(bytes.equals(BIG), '字节必须逐位一致')
  assert.equal(id, crypto.createHash('sha256').update(BIG).digest('hex').slice(0, 16))
})

test('同一张图只落盘一次（幂等）', () => {
  const files = fs.readdirSync(ASSET_DIR)
  assert.equal(files.filter((f) => f.endsWith('.png')).length, 1)
})

test('图片同样要过网关认证', async () => {
  const files = fs.readdirSync(ASSET_DIR)
  const res = await fetch(base() + '/dg-asset/' + files[0])
  assert.equal(res.status, 401)
})

test('非法 id / 路径穿越一律 404', async () => {
  for (const p of ['/dg-asset/notahash.png', '/dg-asset/' + 'a'.repeat(16) + '.png',
    '/dg-asset/..%2Fconfig.json', '/dg-asset/' + 'b'.repeat(16) + '.exe']) {
    const res = await fetch(base() + p, { headers: auth })
    assert.equal(res.status, 404, p)
  }
})

test('向 dsh 取 bundle 时不带 accept-encoding（否则压缩过就无法改写）', () => {
  const hit = seen.filter((s) => s.url.startsWith('/plugins/')).pop()
  assert.equal(hit.ae, '')
  assert.equal(hit.host, '127.0.0.1:' + UP_PORT)
})

test('客户端接受 gzip 时，改写后的 bundle 仍然压缩下发', async () => {
  const res = await rawGet('/plugins/??pkg/client.js&rev=abc', { 'Accept-Encoding': 'gzip' })
  assert.equal(res.headers['content-encoding'], 'gzip')
  const body = zlib.gunzipSync(res.body).toString()
  assert.match(body, /\/dg-asset\/[0-9a-f]{16}\.png/)
})

test('非 /plugins/ 的 JS 不参与改写（范围限定），但照常压缩', async () => {
  const res = await rawGet('/static/app.js', { 'Accept-Encoding': 'gzip' })
  const body = zlib.gunzipSync(res.body).toString()
  assert.ok(body.includes(BIG_B64), '别的路径不该动内容')
})

test('上游已自行压缩的 bundle 无法改写 → 原样透传，不报错', async () => {
  const res = await rawGet('/plugins/??pkg/client.js&rev=abc&gzipped=1')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-encoding'], 'gzip')
  const body = zlib.gunzipSync(res.body).toString()
  assert.ok(body.includes(BIG_B64))
})
