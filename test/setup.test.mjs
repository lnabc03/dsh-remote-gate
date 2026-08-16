// setup.mjs 纯函数单测：标志解析、校验、frpc.toml 往返、config.json 合并
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseArgs,
  validateServer,
  validatePort,
  validateToken,
  normalizeDomain,
  validateDomain,
  tomlString,
  readFrpcConfig,
  renderFrpcToml,
  readConfigJson,
  mergeDomain,
  frpcBinaryName,
} from '../setup.mjs'

test('parseArgs：解析所有标志', () => {
  const flags = parseArgs(['--setup', '--server', '1.2.3.4', '--server-port', '7001', '--auth-token', 'tok', '--domain', 'https://dsh.example.com/', '--help'])
  assert.equal(flags.setup, true)
  assert.equal(flags.server, '1.2.3.4')
  assert.equal(flags.serverPort, '7001')
  assert.equal(flags.authToken, 'tok')
  assert.equal(flags.domain, 'https://dsh.example.com/')
  assert.equal(flags.help, true)
})

test('parseArgs：-h 与未知标志', () => {
  const flags = parseArgs(['-h', '--bogus', 'x'])
  assert.equal(flags.help, true)
})

test('validateServer / validatePort / validateToken', () => {
  assert.equal(validateServer('8.135.34.161'), null)
  assert.equal(validateServer('dsh.example.com'), null)
  assert.ok(validateServer(''))
  assert.ok(validateServer('a b'))
  assert.ok(validateServer('http://x/y'))

  assert.equal(validatePort('7000'), null)
  assert.equal(validatePort(7000), null)
  assert.ok(validatePort('0'))
  assert.ok(validatePort('65536'))
  assert.ok(validatePort('abc'))

  assert.equal(validateToken('secret'), null)
  assert.ok(validateToken(''))
})

test('normalizeDomain / validateDomain', () => {
  assert.equal(normalizeDomain('https://dsh.example.com/'), 'dsh.example.com')
  assert.equal(normalizeDomain('http://dsh.example.com'), 'dsh.example.com')
  assert.equal(normalizeDomain('dsh.example.com/'), 'dsh.example.com')
  assert.equal(validateDomain('dsh.example.com'), null)
  assert.equal(validateDomain('dsh.example.com:8443'), null)
  assert.ok(validateDomain(''))
  assert.ok(validateDomain('a b'))
})

test('tomlString 转义', () => {
  assert.equal(tomlString('abc'), '"abc"')
  assert.equal(tomlString('a"b'), '"a\\"b"')
  assert.equal(tomlString('a\\b'), '"a\\\\b"')
})

test('renderFrpcToml → readFrpcConfig 往返无损', () => {
  const values = { serverAddr: '8.135.34.161', serverPort: 7000, authToken: 'd9fd-TOKEN' }
  const rendered = renderFrpcToml(values)
  const parsed = readFrpcConfig(rendered)
  assert.equal(parsed.serverAddr, values.serverAddr)
  assert.equal(parsed.serverPort, values.serverPort)
  assert.equal(parsed.authToken, values.authToken)
})

test('renderFrpcToml 含需要转义的 token 仍往返无损', () => {
  const token = 'a"b\\c'
  const rendered = renderFrpcToml({ serverAddr: 'x', serverPort: 7000, authToken: token })
  assert.equal(readFrpcConfig(rendered).authToken, token)
})

test('renderFrpcToml 固定默认值存在', () => {
  const rendered = renderFrpcToml({ serverAddr: 'x', serverPort: 7000, authToken: 't' })
  assert.match(rendered, /transport\.poolCount = 20/)
  assert.match(rendered, /remotePort = 3088/)
  assert.match(rendered, /localIP = "127\.0\.0\.1"/)
  assert.match(rendered, /auth\.method = "token"/)
})

test('readFrpcConfig 解析真实格式 frpc.toml', () => {
  const text = [
    'serverAddr = "8.135.34.161"',
    'serverPort = 7000',
    'auth.method = "token"',
    'auth.token = "deadbeef"',
    'transport.poolCount = 20',
    '',
    '[[proxies]]',
    'name = "dsh-mobile"',
    'remotePort = 3088',
  ].join('\n')
  const parsed = readFrpcConfig(text)
  assert.equal(parsed.serverAddr, '8.135.34.161')
  assert.equal(parsed.serverPort, 7000)
  assert.equal(parsed.authToken, 'deadbeef')
})

test('readConfigJson / mergeDomain', () => {
  assert.deepEqual(readConfigJson('not json'), {})
  assert.deepEqual(readConfigJson('[]'), {})
  const cfg = readConfigJson('{"token":"t"}')
  assert.deepEqual(mergeDomain(cfg, 'dsh.example.com'), { token: 't', domain: 'dsh.example.com' })
  assert.equal(cfg.domain, undefined, 'mergeDomain 不应改动入参')
})

test('frpcBinaryName 按平台', () => {
  assert.equal(frpcBinaryName('win32'), 'frpc.exe')
  assert.equal(frpcBinaryName('linux'), 'frpc')
  assert.equal(frpcBinaryName('darwin'), 'frpc')
})
