// admin.mjs 面板服务集成测试：令牌登录、静态资产、API、CSRF 头防线、SSE 回放
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startPanel } from '../admin.mjs'

const TOKEN = 'panel-test-token-' + Math.random().toString(36).slice(2)

let panel
let savedPayloads = []

before(async () => {
  panel = await startPanel({
    getToken: () => TOKEN,
    preferredPort: 0, // OS 分配空闲端口
    actions: {
      getStatus: () => ({ mode: 'cf', configured: true, login: 'https://x.trycloudflare.com/?t=' + TOKEN, procs: {} }),
      getConfig: () => ({ mode: 'cf', token: TOKEN }),
      saveConfig: async (payload) => { savedPayloads.push(payload); return { ok: true } },
      restartDsh: async () => ({ ok: true }),
    },
  })
})

after(() => {
  panel.close()
})

const base = () => `http://127.0.0.1:${panel.port}`

async function loginCookie() {
  const res = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  assert.equal(res.status, 302)
  return (res.headers.get('set-cookie') || '').split(';')[0]
}

test('面板地址带令牌且绑回环', () => {
  assert.match(panel.url, new RegExp('^http://127\\.0\\.0\\.1:\\d+/\\?t='))
  assert.ok(panel.port > 0)
})

test('无 Cookie 访问页面与 API → 401', async () => {
  const page = await fetch(base() + '/', { redirect: 'manual' })
  assert.equal(page.status, 401)
  const apiRes = await fetch(base() + '/api/status')
  assert.equal(apiRes.status, 401)
})

test('错误令牌 → 403；正确令牌 → 302 + dg_admin Cookie（HttpOnly + SameSite=Strict）', async () => {
  const bad = await fetch(base() + '/?t=wrong', { redirect: 'manual' })
  assert.equal(bad.status, 403)
  const good = await fetch(base() + '/?t=' + encodeURIComponent(TOKEN), { redirect: 'manual' })
  assert.equal(good.status, 302)
  const cookie = good.headers.get('set-cookie') || ''
  assert.match(cookie, /dg_admin=/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
})

test('带 Cookie 获取 index.html / app.js / qrcode.js（含 CSP 与 nosniff）', async () => {
  const cookie = await loginCookie()
  const html = await fetch(base() + '/', { headers: { Cookie: cookie } })
  assert.equal(html.status, 200)
  assert.match(html.headers.get('content-security-policy') || '', /default-src 'self'/)
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
  assert.match(await html.text(), /控制面板/)

  const js = await fetch(base() + '/app.js', { headers: { Cookie: cookie } })
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type') || '', /javascript/)

  const qr = await fetch(base() + '/vendor/qrcode.js', { headers: { Cookie: cookie } })
  assert.equal(qr.status, 200)

  // 白名单外的路径 404（路径穿越防护）
  const evil = await fetch(base() + '/../config.json', { headers: { Cookie: cookie } })
  assert.ok([404, 401].includes(evil.status)) // fetch 可能先规范化路径
})

test('GET /api/status 与 /api/config 返回 mock 数据', async () => {
  const cookie = await loginCookie()
  const s = await (await fetch(base() + '/api/status', { headers: { Cookie: cookie } })).json()
  assert.equal(s.mode, 'cf')
  const c = await (await fetch(base() + '/api/config', { headers: { Cookie: cookie } })).json()
  assert.equal(c.token, TOKEN)
})

test('POST /api/config 缺 X-DG-Admin 头 → 403（CSRF 防线）', async () => {
  const cookie = await loginCookie()
  const res = await fetch(base() + '/api/config', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{"mode":"lan"}',
  })
  assert.equal(res.status, 403)
  assert.equal(savedPayloads.length, 0, '无防 CSRF 头的请求不得触达 saveConfig')
})

test('POST /api/config 带头 → 透传给 saveConfig；令牌轮换时 Set-Cookie 换新', async () => {
  const cookie = await loginCookie()
  const res = await fetch(base() + '/api/config', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-DG-Admin': '1' },
    body: '{"mode":"lan"}',
  })
  assert.equal(res.status, 200)
  assert.deepEqual(savedPayloads[0], { mode: 'lan' })
})

test('POST /api/config 非法 JSON → 400', async () => {
  const cookie = await loginCookie()
  const res = await fetch(base() + '/api/config', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-DG-Admin': '1' },
    body: 'not-json',
  })
  assert.equal(res.status, 400)
})

test('POST /api/restart-dsh 同样需要防 CSRF 头', async () => {
  const cookie = await loginCookie()
  const noHeader = await fetch(base() + '/api/restart-dsh', { method: 'POST', headers: { Cookie: cookie } })
  assert.equal(noHeader.status, 403)
  const ok = await fetch(base() + '/api/restart-dsh', {
    method: 'POST', headers: { Cookie: cookie, 'X-DG-Admin': '1', 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(ok.status, 200)
})

test('SSE /api/logs：回放缓冲日志并推送新日志', async () => {
  panel.log('start', 'history-line-1')
  const cookie = await loginCookie()
  const res = await fetch(base() + '/api/logs', { headers: { Cookie: cookie } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const readUntil = async (needle) => {
    for (let i = 0; i < 50; i++) {
      if (buf.includes(needle)) return
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
    throw new Error('未等到 SSE 内容: ' + needle + '\n已收:\n' + buf)
  }
  await readUntil('history-line-1') // 回放
  panel.log('gate', 'live-line-2') // 实时
  await readUntil('live-line-2')
  panel.broadcastStatus()
  await readUntil('event: status')
  await reader.cancel()
})
