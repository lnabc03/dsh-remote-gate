// start.mjs 导出的日志过滤纯函数单测（导入安全：main 由 isMain 守卫）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldIgnoreLine, FRPC_IGNORE, CF_IGNORE, CF_IGNORE_RE, extractCfUrl } from '../start.mjs'

test('shouldIgnoreLine：frpc 的 pool-full 告警被过滤', () => {
  const noisy = '2026-08-17 00:38:19 [E] [client/control.go:153] StartWorkConn contains error: work connection pool is full, discarding'
  assert.equal(shouldIgnoreLine('frpc', noisy), true)
})

test('shouldIgnoreLine：非目标行保留', () => {
  assert.equal(shouldIgnoreLine('frpc', '2026-08-17 00:38:19 [I] frpc 启动成功'), false)
})

test('shouldIgnoreLine：只作用于 frpc tag，不影响 dsh/gate', () => {
  const noisy = 'work connection pool is full'
  assert.equal(shouldIgnoreLine('dsh', noisy), false)
  assert.equal(shouldIgnoreLine('gate', noisy), false)
})

test('FRPC_IGNORE 非空且为字符串数组', () => {
  assert.ok(Array.isArray(FRPC_IGNORE))
  assert.ok(FRPC_IGNORE.length > 0)
  assert.ok(FRPC_IGNORE.every((n) => typeof n === 'string'))
})

// cloudflared quick tunnel 真实输出样例（时间戳 INF 前缀 + 边框）
const CF_BOX = [
  '2026-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+',
  '2026-01-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  '2026-01-01T00:00:00Z INF |  https://aging-buckets-abcde.trycloudflare.com                                                |',
  '2026-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+',
]

test('extractCfUrl：从 cloudflared 边框行抓出临时域名', () => {
  assert.equal(extractCfUrl(CF_BOX[2]), 'https://aging-buckets-abcde.trycloudflare.com')
  assert.equal(extractCfUrl(CF_BOX[0]), null)
  assert.equal(extractCfUrl('2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0'), null)
  assert.equal(extractCfUrl(''), null)
})

test('shouldIgnoreLine：cloudflared 的公告/边框/URL 行被过滤（URL 由 start 自行打印）', () => {
  for (const line of CF_BOX) assert.equal(shouldIgnoreLine('cf', line), true)
  assert.equal(shouldIgnoreLine('cf', '2026-01-01T00:00:00Z WRN Thank you for trying Cloudflare Tunnel. Doing so without a certificate...'), true)
})

// 新版 cloudflared 的连通性预检表（信息框 + 明细行）
test('shouldIgnoreLine：cloudflared 预检表与明细被过滤，汇总行保留', () => {
  const box = [
    '2026-01-01T00:00:00Z INF |                               CONNECTIVITY PRE-CHECKS                               |',
    '2026-01-01T00:00:00Z INF |  DNS Resolution    region1.v2.argotunnel.com  PASS    DNS Resolved successfully     |',
    '2026-01-01T00:00:00Z INF |                                                                                     |',
  ]
  for (const line of box) assert.equal(shouldIgnoreLine('cf', line), true)
  assert.equal(shouldIgnoreLine('cf', '2026-01-01T00:00:00Z INF precheck component="DNS Resolution" details="DNS Resolved successfully" status=pass target=region1.v2.argotunnel.com'), true)
  assert.equal(shouldIgnoreLine('cf', '2026-01-01T00:00:00Z INF precheck complete hard_fail=false suggested_protocol=quic'), false)
})

test('shouldIgnoreLine：cloudflared 的 NO_ERROR 取消流噪声被过滤（ERR 级别但无害）', () => {
  assert.equal(shouldIgnoreLine('cf', '2026-01-01T00:00:00Z ERR  error="stream 189 canceled by remote with error code 0" connIndex=0 event=1'), true)
  // error code 非 0 的真错误必须保留
  assert.equal(shouldIgnoreLine('cf', '2026-01-01T00:00:00Z ERR  error="stream 189 canceled by remote with error code 2" connIndex=0'), false)
})

test('shouldIgnoreLine：cf 的其余日志保留，且过滤不影响别的 tag', () => {
  assert.equal(shouldIgnoreLine('cf', '2026-01-01T00:00:00Z INF Registered tunnel connection connIndex=0'), false)
  assert.equal(shouldIgnoreLine('cf', '2026-01-01T00:00:00Z INF Version 2026.8.2'), false)
  assert.equal(shouldIgnoreLine('gate', CF_BOX[2]), false)
})

test('CF_IGNORE / CF_IGNORE_RE 形状', () => {
  assert.ok(Array.isArray(CF_IGNORE))
  assert.ok(CF_IGNORE.length > 0)
  assert.ok(CF_IGNORE.every((n) => typeof n === 'string'))
  assert.ok(CF_IGNORE_RE instanceof RegExp)
})
