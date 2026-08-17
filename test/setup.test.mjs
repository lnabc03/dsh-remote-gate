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
  normalizeMode,
  validateMode,
  validateSshUser,
  validateSshKeyPath,
  defaultSshKeyPath,
  tomlString,
  readFrpcConfig,
  renderFrpcToml,
  readConfigJson,
  mergeDomain,
  frpcBinaryName,
  cloudflaredBinaryName,
  buildSshReverseArgs,
  buildSshProbeArgs,
  analyzeSshResult,
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

test('parseArgs：解析 ssh 模式标志', () => {
  const flags = parseArgs(['--mode', 'ssh', '--ssh-host', '203.0.113.10', '--ssh-port', '2222', '--ssh-user', 'deploy', '--ssh-key', 'C:\\k\\id'])
  assert.equal(flags.mode, 'ssh')
  assert.equal(flags.sshHost, '203.0.113.10')
  assert.equal(flags.sshPort, '2222')
  assert.equal(flags.sshUser, 'deploy')
  assert.equal(flags.sshKey, 'C:\\k\\id')
})

test('parseArgs：解析 lan 模式标志', () => {
  const flags = parseArgs(['--mode', 'lan'])
  assert.equal(flags.mode, 'lan')
})

test('parseArgs：解析 cf 模式标志', () => {
  const flags = parseArgs(['--mode', 'cf'])
  assert.equal(flags.mode, 'cf')
})

test('validateServer / validatePort / validateToken', () => {
  assert.equal(validateServer('203.0.113.10'), null)
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
  const values = { serverAddr: '203.0.113.10', serverPort: 7000, authToken: 'd9fd-TOKEN' }
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
    'serverAddr = "203.0.113.10"',
    'serverPort = 7000',
    'auth.method = "token"',
    'auth.token = "deadbeef"',
    'transport.poolCount = 20',
    '',
    '[[proxies]]',
    'name = "dsh-remote-gate"',
    'remotePort = 3088',
  ].join('\n')
  const parsed = readFrpcConfig(text)
  assert.equal(parsed.serverAddr, '203.0.113.10')
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

test('cloudflaredBinaryName 按平台', () => {
  assert.equal(cloudflaredBinaryName('win32'), 'cloudflared.exe')
  assert.equal(cloudflaredBinaryName('linux'), 'cloudflared')
  assert.equal(cloudflaredBinaryName('darwin'), 'cloudflared')
})

test('validateMode / normalizeMode', () => {
  assert.equal(validateMode('frp'), null)
  assert.equal(validateMode('SSH'), null)
  assert.equal(validateMode('lan'), null)
  assert.equal(validateMode(' LAN '), null)
  assert.equal(validateMode('cf'), null)
  assert.equal(validateMode(' CF '), null)
  assert.equal(normalizeMode('  Ssh '), 'ssh')
  assert.equal(normalizeMode(' Lan '), 'lan')
  assert.equal(normalizeMode(' Cf '), 'cf')
  assert.ok(validateMode('ftp'))
  assert.ok(validateMode(''))
})

test('validateSshUser / validateSshKeyPath', () => {
  assert.equal(validateSshUser('deploy'), null)
  assert.ok(validateSshUser(''))
  assert.ok(validateSshUser('a b'))
  assert.ok(validateSshUser('a@b'))
  assert.ok(validateSshUser('a:b'))
  assert.equal(validateSshKeyPath('C:\\k\\id'), null)
  assert.ok(validateSshKeyPath(''))
})

test('defaultSshKeyPath 指向家目录 id_ed25519', () => {
  const p = defaultSshKeyPath()
  assert.ok(p.endsWith('id_ed25519'))
  assert.ok(p.includes('.ssh'))
})

test('buildSshReverseArgs 参数完整且顺序正确', () => {
  const args = buildSshReverseArgs({ host: '203.0.113.10', port: 22, user: 'deploy', keyPath: '/k/id' })
  assert.ok(args.includes('-N') && args.includes('-T'))
  assert.ok(args.includes('-R'))
  assert.ok(args.includes('3088:127.0.0.1:3088'))
  assert.ok(args.includes('-i'))
  assert.ok(args.includes('/k/id'))
  assert.ok(args.includes('-p'))
  assert.ok(args.includes('22'))
  assert.ok(args.includes('deploy@203.0.113.10'))
  // 选项必须在目的地址之前
  assert.ok(args.indexOf('deploy@203.0.113.10') === args.length - 1)
  const joined = args.join(' ')
  assert.ok(joined.includes('StrictHostKeyChecking=yes'))
  assert.ok(joined.includes('BatchMode=yes'))
  assert.ok(joined.includes('ExitOnForwardFailure=yes'))
  assert.ok(joined.includes('ServerAliveInterval=15'))
})

test('buildSshProbeArgs 以远程 true 收尾', () => {
  const args = buildSshProbeArgs({ host: 'h', port: 22, user: 'u', keyPath: '/k' })
  assert.equal(args[args.length - 1], 'true')
  assert.equal(args[args.length - 2], 'u@h')
})

test('analyzeSshResult 分类各失败场景', () => {
  assert.equal(analyzeSshResult({ status: 0 }).status, 'ok')
  assert.equal(analyzeSshResult({ status: 255, spawnError: 'spawn ssh ENOENT' }).status, 'ssh-not-found')
  assert.equal(analyzeSshResult({ status: 255, stderr: 'Host key verification failed.' }).status, 'host-key-unverified')
  assert.equal(analyzeSshResult({ status: 255, stderr: 'deploy@h: Permission denied (publickey).' }).status, 'auth-failed')
  assert.equal(analyzeSshResult({ status: 255, stderr: 'ssh: connect to host h port 22: Connection refused' }).status, 'unreachable')
  assert.equal(analyzeSshResult({ status: 1, stderr: 'something else' }).status, 'failed')
})
