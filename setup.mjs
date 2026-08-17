// setup.mjs — 纯函数库：校验/归一化、frpc.toml 渲染与解析、ssh 参数构造与连通性自检
// 交互式命令行配置已移除（由本地控制面板替代，见 admin.mjs / config-lib.mjs）。
// 纯函数被 test/setup.test.mjs 单测；调用方：config-lib.mjs（校验/渲染）、start.mjs（ssh 参数/自检）。

import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// ---- CLI 标志（保留解析工具；start.mjs 只消费 --no-ui/--help，其余标志由面板取代） ---------
export function parseArgs(argv) {
  const flags = {
    setup: false,
    mode: undefined,
    server: undefined,
    serverPort: undefined,
    authToken: undefined,
    domain: undefined,
    sshHost: undefined,
    sshPort: undefined,
    sshUser: undefined,
    sshKey: undefined,
    noUi: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => (i + 1 < argv.length ? argv[++i] : undefined)
    if (a === '--setup') flags.setup = true
    else if (a === '--mode') flags.mode = next()
    else if (a === '--server') flags.server = next()
    else if (a === '--server-port') flags.serverPort = next()
    else if (a === '--auth-token') flags.authToken = next()
    else if (a === '--domain') flags.domain = next()
    else if (a === '--ssh-host') flags.sshHost = next()
    else if (a === '--ssh-port') flags.sshPort = next()
    else if (a === '--ssh-user') flags.sshUser = next()
    else if (a === '--ssh-key') flags.sshKey = next()
    else if (a === '--no-ui') flags.noUi = true
    else if (a === '--help' || a === '-h') flags.help = true
    // 未知标志静默忽略，交给其余逻辑
  }
  return flags
}

// ---- 校验 / 归一化 --------------------------------------------------------------
export function validateServer(v) {
  const s = String(v ?? '').trim()
  if (s === '') return 'frps 服务器地址不能为空'
  if (/[\s/]/.test(s)) return '地址不能包含空格或斜杠（只填主机名或 IP）'
  return null
}

export function validatePort(v) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return '端口必须是 1–65535 的整数'
  return null
}

export function validateToken(v) {
  const s = String(v ?? '').trim()
  if (s === '') return 'frps 认证 token 不能为空'
  return null
}

export function normalizeDomain(v) {
  return String(v ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim()
}

export function validateDomain(v) {
  const s = normalizeDomain(v)
  if (s === '') return '公网域名不能为空'
  if (/[\s/]/.test(s)) return '域名不能包含空格或斜杠（只填主机名，可带 :端口）'
  return null
}

export function normalizeMode(v) {
  return String(v ?? '').trim().toLowerCase()
}

export function validateMode(v) {
  const s = normalizeMode(v)
  if (s === 'frp' || s === 'ssh' || s === 'lan' || s === 'cf') return null
  return '访问模式只能是 frp、ssh、lan 或 cf'
}

export function validateSshUser(v) {
  const s = String(v ?? '').trim()
  if (s === '') return 'SSH 用户名不能为空'
  if (/[\s@:]/.test(s)) return '用户名不能包含空格、@ 或冒号'
  return null
}

export function validateSshKeyPath(v) {
  const s = String(v ?? '').trim()
  if (s === '') return 'SSH 私钥路径不能为空'
  return null
}

export function defaultSshKeyPath() {
  return path.join(os.homedir(), '.ssh', 'id_ed25519')
}

// ---- frpc.toml 渲染 / 解析 ------------------------------------------------------
export function tomlString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// 只读取迁移需要的那 3 个标量键；不保留未知内容（全量重写策略）。
function unquoteToml(v) {
  if (v.length < 2) return v
  const q = v[0]
  if ((q !== '"' && q !== "'") || v[v.length - 1] !== q) return v
  let s = v.slice(1, -1)
  if (q === '"') s = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return s
}

export function readFrpcConfig(text) {
  const cfg = { serverAddr: undefined, serverPort: undefined, authToken: undefined }
  const get = (key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('^\\s*' + escaped + '\\s*=\\s*([^\\r\\n]+)', 'm')
    const m = String(text || '').match(re)
    if (!m) return undefined
    return unquoteToml(m[1].trim())
  }
  cfg.serverAddr = get('serverAddr')
  const sp = get('serverPort')
  cfg.serverPort = sp === undefined ? undefined : Number(sp)
  cfg.authToken = get('auth.token')
  return cfg
}

export function renderFrpcToml({ serverAddr, serverPort, authToken }) {
  return [
    '# frpc 配置 — dsh-remote-gate 网关隧道',
    '# 由 config-lib.mjs 从 config.json 全量重生成（数据源是 config.json 的 frp 字段，勿手动编辑）。',
    '# 本文件含 frps 认证 token，勿提交（已 gitignore）。',
    '',
    'serverAddr = ' + tomlString(serverAddr),
    'serverPort = ' + serverPort,
    '',
    'auth.method = "token"',
    'auth.token = ' + tomlString(authToken),
    '',
    '# 断线自动重连',
    'transport.dialServerTimeout = 10',
    'transport.dialServerKeepalive = 7200',
    '',
    '# 预建工作连接池：手机加载 SPA 时并发几十个连接，默认池太小会刷',
    '# "work connection pool is full" 并拖慢页面。注意需同时调大 frps 端的',
    '# transport.maxPoolCount（默认 5），超过它的部分仍会被丢弃。',
    'transport.poolCount = 20',
    '',
    '[[proxies]]',
    'name = "dsh-remote-gate"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 3088',
    'remotePort = 3088',
    '',
  ].join('\n')
}

// ---- config.json ---------------------------------------------------------------
export function readConfigJson(text) {
  try {
    const obj = JSON.parse(text)
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

export function mergeDomain(cfg, domain) {
  return { ...cfg, domain }
}

// ---- frpc 可执行文件 -------------------------------------------------------------
export function frpcBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'frpc.exe' : 'frpc'
}

// ---- cloudflared 可执行文件（cf 模式） ---------------------------------------------
export function cloudflaredBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

// ---- SSH 反向隧道 ---------------------------------------------------------------
// 共享选项：密钥认证、严格主机校验、超时；host key 未预先录入时拒连（防中间人）。
function sshCommonOptions(keyPath, port) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-i', keyPath,
    '-p', String(port),
  ]
}

// 反向隧道：把服务器 127.0.0.1:remotePort 回灌到本机 gateway(localPort)。
// remotePort 固定 3088（服务器反代硬编码指向它），localPort 固定 gateway 3088。
export function buildSshReverseArgs({ host, port, user, keyPath, remotePort = 3088, localPort = 3088 }) {
  return [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...sshCommonOptions(keyPath, port),
    '-R', `${remotePort}:127.0.0.1:${localPort}`,
    `${user}@${host}`,
  ]
}

// 连通性自检：非交互登入执行远程 true，验证账号/密钥/主机指纹/网络。
export function buildSshProbeArgs({ host, port, user, keyPath }) {
  return [...sshCommonOptions(keyPath, port), `${user}@${host}`, 'true']
}

export function analyzeSshResult({ status, stderr = '', spawnError = '' }) {
  if (spawnError) return { status: 'ssh-not-found' }
  if (status === 0) return { status: 'ok' }
  const err = String(stderr)
  if (/Host key verification failed/i.test(err)) return { status: 'host-key-unverified' }
  if (/Permission denied|publickey|no matching host key|Too many authentication failures/i.test(err)) return { status: 'auth-failed' }
  if (/Connection timed out|Connection refused|Could not resolve host|Connection (closed|reset)|Network is unreachable/i.test(err)) return { status: 'unreachable' }
  return { status: 'failed' }
}

// 探测 ssh 是否存在 + 能否登入；返回 { status, hint }。
export function sshSelfCheck({ host, port, user, keyPath }) {
  const r = spawnSync('ssh', buildSshProbeArgs({ host, port, user, keyPath }), {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, encoding: 'utf8',
  })
  return attachSshHint(analyzeSshResult({ status: r.status, stderr: r.stderr, spawnError: r.error && r.error.message }), { host, user })
}

export function attachSshHint(result, { host, user }) {
  switch (result.status) {
    case 'ssh-not-found':
      result.hint = '未找到 ssh 客户端；Windows 请在「设置 → 系统 → 可选功能」安装「OpenSSH 客户端」。'
      break
    case 'host-key-unverified':
      result.hint = `首次连接需先录入主机指纹：请在命令行手动执行一次 ssh ${user}@${host} 并确认指纹。`
      break
    case 'auth-failed':
      result.hint = `公钥认证失败：请确认私钥正确，且公钥已加入服务器 ${user} 的 ~/.ssh/authorized_keys。`
      break
    case 'unreachable':
      result.hint = `无法连接 ${host}：请检查服务器地址/端口、sshd 是否运行、AllowTcpForwarding 是否开启。`
      break
    default:
      result.hint = 'SSH 连通性自检未通过，请检查服务器与认证配置。'
  }
  return result
}
