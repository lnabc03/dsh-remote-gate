// config-lib.mjs 单测：面板表单校验、迁移、落盘、前置检查、令牌
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadConfig, saveConfigAtomic, ensureToken, newToken,
  migrateFrpIntoConfig, validatePanelConfig, isConfigured,
  preflightForMode, applyPanelConfig,
} from '../config-lib.mjs'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dg-configlib-'))
}

test('validatePanelConfig：frp 模式字段齐全', () => {
  const r = validatePanelConfig({
    mode: 'frp', domain: 'https://dsh.example.com/',
    frp: { serverAddr: '203.0.113.10', serverPort: '7001', authToken: 'tok' },
  })
  assert.equal(r.errors, null)
  assert.equal(r.config.mode, 'frp')
  assert.equal(r.config.domain, 'dsh.example.com') // 归一化去协议去尾斜杠
  assert.deepEqual(r.config.frp, { serverAddr: '203.0.113.10', serverPort: 7001, authToken: 'tok' })
})

test('validatePanelConfig：frp 缺字段逐条报错', () => {
  const r = validatePanelConfig({ mode: 'frp', domain: '', frp: { serverAddr: '', serverPort: 'abc', authToken: '' } })
  assert.ok(r.errors.domain)
  assert.ok(r.errors['frp.serverAddr'])
  assert.ok(r.errors['frp.serverPort'])
  assert.ok(r.errors['frp.authToken'])
})

test('validatePanelConfig：ssh 模式校验 + 默认值回填 existing', () => {
  const existing = { mode: 'lan', token: 'keep-me', ssh: { host: 'h', port: 2222, user: 'u', keyPath: 'C:\\k\\id' } }
  const r = validatePanelConfig({ mode: 'ssh', domain: 'dsh.example.com', ssh: { host: '', port: '', user: '', keyPath: '' } }, existing)
  // 空串字段回退 existing.ssh 的值
  assert.equal(r.errors, null)
  assert.deepEqual(r.config.ssh, { host: 'h', port: 2222, user: 'u', keyPath: 'C:\\k\\id' })
  assert.equal(r.config.token, 'keep-me') // 未给令牌则保留
})

test('validatePanelConfig：ssh 非法字段报错', () => {
  const r = validatePanelConfig({ mode: 'ssh', domain: 'd', ssh: { host: 'a b', port: '0', user: 'a@b', keyPath: '' } })
  assert.ok(r.errors['ssh.host'])
  assert.ok(r.errors['ssh.port'])
  assert.ok(r.errors['ssh.user'])
})

test('validatePanelConfig：lan/cf 无必填字段，模式非法报错', () => {
  assert.equal(validatePanelConfig({ mode: 'lan' }).errors, null)
  assert.equal(validatePanelConfig({ mode: ' CF ' }).config.mode, 'cf')
  assert.ok(validatePanelConfig({ mode: 'ftp' }).errors.mode)
})

test('validatePanelConfig：令牌规则（留空不动、太短信空白报错）', () => {
  const keep = validatePanelConfig({ mode: 'lan', token: '' }, { token: 'old-token' })
  assert.equal(keep.config.token, 'old-token')
  const short = validatePanelConfig({ mode: 'lan', token: 'abc' })
  assert.ok(short.errors.token)
  const ok = validatePanelConfig({ mode: 'lan', token: 'new-token-12345678' }, { token: 'old' })
  assert.equal(ok.errors, null)
  assert.equal(ok.config.token, 'new-token-12345678')
})

test('isConfigured 按模式判定', () => {
  assert.equal(isConfigured({}), false)
  assert.equal(isConfigured({ mode: 'lan' }), true)
  assert.equal(isConfigured({ mode: 'cf' }), true)
  assert.equal(isConfigured({ mode: 'frp' }), false)
  assert.equal(isConfigured({ mode: 'frp', frp: { serverAddr: 'x', authToken: 't' } }), true)
  assert.equal(isConfigured({ mode: 'ssh', ssh: { host: 'h', user: 'u' } }), true)
  assert.equal(isConfigured({ mode: 'ssh', ssh: { host: 'h' } }), false)
})

test('migrateFrpIntoConfig：老安装 frpc.toml → config.json.frp', () => {
  const dir = tmpdir()
  const frpcPath = path.join(dir, 'frpc.toml')
  fs.writeFileSync(frpcPath, [
    'serverAddr = "203.0.113.10"',
    'serverPort = 7001',
    'auth.token = "deadbeef"',
  ].join('\n'))
  const r = migrateFrpIntoConfig({ mode: 'frp', token: 'x' }, frpcPath)
  assert.equal(r.migrated, true)
  assert.deepEqual(r.cfg.frp, { serverAddr: '203.0.113.10', serverPort: 7001, authToken: 'deadbeef' })
  assert.equal(r.cfg.token, 'x')
})

test('migrateFrpIntoConfig：已有 frp 字段或无文件时不迁移', () => {
  const dir = tmpdir()
  const has = migrateFrpIntoConfig({ frp: { serverAddr: 'a', serverPort: 1, authToken: 'b' } }, path.join(dir, 'none.toml'))
  assert.equal(has.migrated, false)
  const none = migrateFrpIntoConfig({}, path.join(dir, 'none.toml'))
  assert.equal(none.migrated, false)
})

test('saveConfigAtomic + loadConfig 往返；ensureToken 生成并持久化', () => {
  const dir = tmpdir()
  const p = path.join(dir, 'config.json')
  saveConfigAtomic({ mode: 'lan' }, p)
  assert.equal(fs.existsSync(p + '.tmp-' + process.pid), false, '临时文件应已 rename')
  assert.deepEqual(loadConfig(p), { mode: 'lan' })
  const { cfg, generated } = ensureToken(loadConfig(p), p)
  assert.equal(generated, true)
  assert.ok(cfg.token.length > 20)
  assert.equal(loadConfig(p).token, cfg.token, '令牌应已写盘')
  const again = ensureToken(loadConfig(p), p)
  assert.equal(again.generated, false, '已有令牌不再生成')
  assert.equal(again.cfg.token, cfg.token)
})

test('newToken 为 base64url 且每次不同', () => {
  const a = newToken(); const b = newToken()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9_-]+$/)
})

test('applyPanelConfig：frp 模式同时重生成 frpc.toml', () => {
  const dir = tmpdir()
  const configPath = path.join(dir, 'config.json')
  const frpcPath = path.join(dir, 'frpc.toml')
  applyPanelConfig({
    mode: 'frp', domain: 'dsh.example.com',
    frp: { serverAddr: '203.0.113.10', serverPort: 7000, authToken: 'tok-en' },
  }, { configPath, frpcPath })
  assert.equal(loadConfig(configPath).frp.authToken, 'tok-en')
  const toml = fs.readFileSync(frpcPath, 'utf8')
  assert.match(toml, /serverAddr = "203\.0\.113\.10"/)
  assert.match(toml, /auth\.token = "tok-en"/)
  // lan 模式不写 frpc.toml
  const dir2 = tmpdir()
  applyPanelConfig({ mode: 'lan' }, { configPath: path.join(dir2, 'config.json'), frpcPath: path.join(dir2, 'frpc.toml') })
  assert.equal(fs.existsSync(path.join(dir2, 'frpc.toml')), false)
})

test('preflightForMode：frp/cf 缺二进制给 hint，lan/ssh 直接过', () => {
  const dir = tmpdir() // 空目录：两个二进制都不存在
  assert.equal(preflightForMode('lan', dir).ok, true)
  assert.equal(preflightForMode('ssh', dir).ok, true)
  const frp = preflightForMode('frp', dir)
  assert.equal(frp.ok, false)
  assert.match(frp.hint, /frp[\\/]frpc/)
  const cf = preflightForMode('cf', dir)
  assert.equal(cf.ok, false)
  assert.match(cf.hint, /cf[\\/]cloudflared/)
  // 放二进制后放行
  fs.mkdirSync(path.join(dir, 'cf'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cf', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), 'x')
  assert.equal(preflightForMode('cf', dir).ok, true)
})
