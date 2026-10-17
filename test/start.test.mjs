// start.mjs 导出的日志过滤纯函数单测（导入安全：main 由 isMain 守卫）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { shouldIgnoreLine, FRPC_IGNORE, CF_IGNORE, CF_IGNORE_RE, extractCfUrl, waitExit, panelWindowSize, panelProfileDir, clearSavedWindowPlacement, formatCrash, samePath, extractDshLaunchToken, rememberTail, formatFatalNote, dshPageUrl } from '../start.mjs'

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

test('extractDshLaunchToken：抓 dsh web 打印的一次性启动令牌', () => {  // dsh 0.2 实际输出格式（带 LAN 尾巴；令牌是 base64url）
  const withLan = 'dsh web: http://127.0.0.1:3080/?token=z29di-8HrOLvtzDAVjJq7Hvx-e3mJbwemhqwjLoIzOE (LAN: http://192.168.1.5:3080/?token=z29di-8HrOLvtzDAVjJq7Hvx-e3mJbwemhqwjLoIzOE)'
  assert.equal(extractDshLaunchToken(withLan), 'z29di-8HrOLvtzDAVjJq7Hvx-e3mJbwemhqwjLoIzOE')
  assert.equal(extractDshLaunchToken('dsh web: http://127.0.0.1:3080/?token=abc_DEF-123'), 'abc_DEF-123')
  // 不能误抓网关自己的 ?t= 登录链接，也不能抓别的日志行
  assert.equal(extractDshLaunchToken('登录链接: https://dsh.example.com/?t=gateway-token'), null)
  assert.equal(extractDshLaunchToken('dsh web: opening the default browser; pass --no-open to disable'), null)
  assert.equal(extractDshLaunchToken(''), null)
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

// waitExit：面板热重启「先等旧进程退出再拉新」的核心原语。
// 回归：旧实现 stopGate 杀完立刻 startGate，新网关 EADDRINUSE 秒退被误判团灭。
test('waitExit：被杀进程退出后 resolve', async () => {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true })
  try {
    await new Promise((resolve, reject) => {
      p.once('spawn', resolve)
      p.once('error', reject)
    })
    p.kill()
    const t0 = Date.now()
    await waitExit(p, 5000)
    assert.ok(p.exitCode !== null || p.signalCode !== null, '进程应已退出')
    assert.ok(Date.now() - t0 < 5000, '应在超时前随 exit 事件返回')
  } finally {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
  }
})

test('waitExit：已退出的进程立即 resolve，不挂起', async () => {
  const p = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true })
  await new Promise((resolve) => p.once('exit', resolve))
  const t0 = Date.now()
  await waitExit(p, 3000)
  assert.ok(Date.now() - t0 < 1000, '已死进程不应等到超时')
})

test('waitExit：进程不退出时按超时兜底 resolve', async () => {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true })
  try {
    await new Promise((resolve, reject) => {
      p.once('spawn', resolve)
      p.once('error', reject)
    })
    const t0 = Date.now()
    await waitExit(p, 200)
    assert.ok(Date.now() - t0 >= 150, '应等待到超时')
    assert.equal(p.exitCode, null, '超时兜底不杀进程')
  } finally {
    p.kill('SIGKILL')
  }
})

test('panelWindowSize：默认 1440×860，环境变量可覆盖，非法值回退默认', () => {
  assert.deepEqual(panelWindowSize({}), { w: 1440, h: 860 })
  assert.deepEqual(panelWindowSize({ DSH_GATE_PANEL_WINSIZE: '1600x900' }), { w: 1600, h: 900 })
  assert.deepEqual(panelWindowSize({ DSH_GATE_PANEL_WINSIZE: '1366,768' }), { w: 1366, h: 768 })
  assert.deepEqual(panelWindowSize({ DSH_GATE_PANEL_WINSIZE: 'abc' }), { w: 1440, h: 860 })
  assert.deepEqual(panelWindowSize({ DSH_GATE_PANEL_WINSIZE: '99x99' }), { w: 1440, h: 860 })
})

test('panelProfileDir：指向 LOCALAPPDATA 下的隔离目录', () => {
  const dir = panelProfileDir()
  assert.ok(dir.includes('dsh-remote-gate'))
  assert.ok(dir.includes('panel-profile'))
})

test('clearSavedWindowPlacement：清除已保存的窗口位置', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-panel-'))
  const defaultDir = path.join(tmpDir, 'Default')
  fs.mkdirSync(defaultDir, { recursive: true })
  const prefs = {
    browser: {
      window_placement: { left: 0, top: 0, right: 1024, bottom: 768 },
      window_placement_popup: { left: 100, top: 100, right: 500, bottom: 400 },
      window_placement_app: { left: 0, top: 0, right: 800, bottom: 600 }
    }
  }
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(prefs), 'utf8')
  clearSavedWindowPlacement(tmpDir)
  const after = JSON.parse(fs.readFileSync(path.join(defaultDir, 'Preferences'), 'utf8'))
  assert.strictEqual(after.browser.window_placement, undefined)
  assert.strictEqual(after.browser.window_placement_popup, undefined)
  assert.strictEqual(after.browser.window_placement_app, undefined)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('clearSavedWindowPlacement：无 Preferences 文件时不抛错', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-panel-'))
  clearSavedWindowPlacement(tmpDir)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('formatCrash：含来源、版本、平台与堆栈，兼容非 Error 输入', () => {
  const err = new Error('boom')
  const text = formatCrash(err, 'uncaughtException', 'v20.0.0', 'win32')
  assert.match(text, /uncaughtException \(node v20\.0\.0, win32\)/)
  assert.match(text, /Error: boom/)
  // 非 Error 的 rejection 值（如字符串）也不应抛错
  const text2 = formatCrash('plain failure', 'unhandledRejection')
  assert.match(text2, /unhandledRejection/)
  assert.match(text2, /plain failure/)
})

test('samePath：同一文件的不同路径形态判等（联接点/大小写）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-samepath-'))
  const file = path.join(tmpDir, 'a.mjs')
  fs.writeFileSync(file, '// x')
  try {
    assert.equal(samePath(file, file), true)
    assert.equal(samePath(file, path.join(tmpDir, 'b.mjs')), false)
    assert.equal(samePath(file, path.join(tmpDir, '不存在.mjs')), false)
    if (process.platform === 'win32') {
      // 盘符/目录大小写差异不影响判等
      assert.equal(samePath(file, file.toLowerCase()), true)
      assert.equal(samePath(file, file.toUpperCase()), true)
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// 隧道致命退出（frpc/cloudflared 退出 = 团灭）会把控制台一起关掉，用户只看到「闪退」。
// 这两条保证「关掉窗口之后仍然查得到原因」。
test('rememberTail：只收 frpc/cf，剥掉 ANSI，且只留最近 20 行', () => {
  const ansi = '\u001b[1;34m2026-10-18 [I] token mismatch\u001b[0m'
  const buf = rememberTail('frpc', ansi)
  assert.deepEqual(buf, ['2026-10-18 [I] token mismatch']) // ANSI 必须剥掉，否则落盘全是色码
  assert.equal(rememberTail('gate', 'should be ignored'), undefined) // 只关心隧道
  assert.equal(rememberTail('dsh', 'should be ignored'), undefined)
  assert.deepEqual(rememberTail('frpc', 'LAST').slice(-1), ['LAST'])

  for (let i = 0; i < 30; i++) rememberTail('cf', 'line-' + i)
  const cf = rememberTail('cf', 'line-final')
  assert.equal(cf.length, 20, '缓冲区上限 20 行')
  assert.equal(cf[cf.length - 1], 'line-final')
  assert.ok(!cf.includes('line-0'), '最早的输出应已被挤出')
})

test('formatFatalNote：含来源、原因与尾部输出，尾部为空时不加分隔行', () => {
  const withTail = formatFatalNote('frpc 意外退出（团灭）', 'code=1 signal=null', ['a', 'b'], '2026-01-01T00:00:00Z', 'v1', 'win32')
  assert.match(withTail, /^\[2026-01-01T00:00:00Z\] frpc 意外退出（团灭） \(node v1, win32\)/)
  assert.match(withTail, /code=1 signal=null/)
  assert.match(withTail, /--- 最近输出 ---/)
  assert.match(withTail, /a\nb/)

  const noTail = formatFatalNote('x', 'y', [], 'NOW', 'v', 'p')
  assert.doesNotMatch(noTail, /--- 最近输出 ---/)
  assert.ok(noTail.endsWith('\n\n'))
})

// 面板的「打开 DSH 页面」按钮：dsh 0.2 起裸开 127.0.0.1:3080 会 401（约束 12），
// 必须带一次性启动令牌换 Cookie，所以 URL 由 /api/status 下发而不是前端硬编码。
test('dshPageUrl：有令牌带 ?token=，无令牌退回裸地址', () => {
  assert.equal(dshPageUrl(3080, 'abc-123_x'), 'http://127.0.0.1:3080/?token=abc-123_x')
  // 令牌是小写+数字+连字符/下划线，不该被转义；但真出现特殊字符时必须编码
  assert.equal(dshPageUrl(3080, null), 'http://127.0.0.1:3080/')
  assert.equal(dshPageUrl(3080, ''), 'http://127.0.0.1:3080/')
  assert.match(dshPageUrl(3080, 'a b&c'), /\?token=a%20b%26c$/)
})
