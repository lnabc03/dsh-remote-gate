// setup.mjs — 首次运行交互式配置（访问模式 frp/ssh/lan；frp/ssh 含公网域名）
// 纯函数（解析/校验/渲染/合并/ssh 参数构造/自检结果分析）可被 test/setup.test.mjs 单测；交互循环与连通性自检只在 ensureConfigured 内触发。
// 由 start.mjs 在启动前调用；也可直接 node setup.mjs 单独跑。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRPC_PATH = path.join(__dirname, 'frp', 'frpc.toml')
const CONFIG_PATH = path.join(__dirname, 'config.json')

// 日志标签与 start.mjs 对齐：'[setup] ' 补齐 8 列，消息列对齐
const SETUP_TAG = '[setup] '
const say = (msg) => console.log(SETUP_TAG + msg)
const sayErr = (msg) => console.error(SETUP_TAG + msg)

// ---- CLI 标志 -----------------------------------------------------------------
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
  if (s === 'frp' || s === 'ssh' || s === 'lan') return null
  return '访问模式只能是 frp、ssh 或 lan'
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

// 只读取 --setup 需要回填默认值的那 3 个标量键；不保留未知内容（全量重写策略）。
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
    '# 由 setup.mjs 生成（首次运行或 --setup）。本文件含 frps 认证 token，勿提交（已 gitignore）。',
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

const FRP_RELEASES = 'https://github.com/fatedier/frp/releases'

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

function attachSshHint(result, { host, user }) {
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

// ---- 交互辅助 -------------------------------------------------------------------
function printUsage() {
  console.log('用法：npm start [选项]')
  console.log('  --setup               强制进入交互式配置（即使已配置）')
  console.log('  --mode <frp|ssh|lan>  访问模式（frp / ssh / lan）')
  console.log('  --domain <域名>       公网域名（如 dsh.example.com；frp/ssh 模式）')
  console.log('  frp 模式：')
  console.log('  --server <地址>       frps 服务器地址')
  console.log('  --server-port <端口>  frps 服务器端口（默认 7000）')
  console.log('  --auth-token <令牌>   frps 认证 token')
  console.log('  ssh 模式：')
  console.log('  --ssh-host <地址>     SSH 服务器地址')
  console.log('  --ssh-port <端口>     SSH 服务器端口（默认 22）')
  console.log('  --ssh-user <用户名>   SSH 用户名')
  console.log('  --ssh-key <路径>      SSH 私钥路径（默认 ~/.ssh/id_ed25519）')
  console.log('  lan 模式：')
  console.log('                       无隧道、无额外字段，网关直连局域网（绑 0.0.0.0）')
  console.log('  --help, -h            显示帮助')
  console.log('')
  console.log('首次运行时若未配置会自动进入交互式配置（lan 模式无前置条件，无需任何字段）。')
}

function promptField(rl, { label, defaultValue, required, validate, normalize }) {
  const ask = (text) => new Promise((resolve) => rl.question(text, resolve))
  return (async () => {
    for (;;) {
      const dft = defaultValue !== undefined && defaultValue !== '' ? ` [${defaultValue}]` : ''
      let answer
      try {
        answer = await ask(`${label}${dft}: `)
      } catch {
        return undefined // stdin 关闭 / EOF
      }
      let value = String(answer ?? '').trim()
      if (value === '' && defaultValue !== undefined && defaultValue !== '') value = String(defaultValue)
      if (value === '') {
        if (required) {
          console.log('  ✗ 此项必填，请重新输入')
          continue
        }
        return ''
      }
      if (normalize) value = normalize(value)
      if (validate) {
        const err = validate(value)
        if (err) {
          console.log('  ✗ ' + err)
          continue
        }
      }
      return value
    }
  })()
}

function printFrpcMissingHint(name) {
  sayErr(`未找到 frp/${name}；请从 ${FRP_RELEASES} 下载对应平台 release，把 ${name} 放进 frp/ 目录后重新运行 npm start`)
  sayErr('配置已写入，下次运行不会再提问。')
}

// ---- 主入口（start.mjs 调用）------------------------------------------------------
// 逐字段收集：标志优先，缺失项交互补齐。返回 { values } | { aborted } | { error }
async function collectFields(specs, nonTty, rl) {
  const values = {}
  const missing = []
  for (const spec of specs) {
    if (spec.flag !== undefined) {
      let v = spec.normalize ? spec.normalize(spec.flag) : String(spec.flag).trim()
      const err = spec.validate ? spec.validate(v) : null
      if (err) {
        sayErr(`标志 ${spec.flagName} 无效：${err}`)
        return { error: 'invalid-flag' }
      }
      values[spec.key] = spec.coerce ? spec.coerce(v) : v
    } else {
      missing.push(spec)
    }
  }
  if (missing.length > 0) {
    if (nonTty) {
      sayErr('未提供完整配置且标准输入不是终端；请用 --mode 及对应标志补全，或交互式运行 npm start。')
      return { error: 'non-tty' }
    }
    for (const spec of missing) {
      const value = await promptField(rl, spec)
      if (value === undefined) return { aborted: true }
      values[spec.key] = spec.coerce ? spec.coerce(value) : value
    }
  }
  return { values }
}

export async function ensureConfigured(argv = [], io = {}) {
  const flags = parseArgs(argv)
  if (flags.help) {
    printUsage()
    return { action: 'exit', code: 0 }
  }

  const frpcExists = fs.existsSync(FRPC_PATH)
  const existingCfg = readConfigJson(readFileOr(CONFIG_PATH))
  const existingFrpc = frpcExists ? readFrpcConfig(readFileOr(FRPC_PATH)) : {}
  const existingSsh = existingCfg.ssh || {}
  const nonTty = io.isTTY === undefined ? !process.stdin.isTTY : !io.isTTY

  // 解析隧道模式：--mode 标志 > config.json > 默认 frp（老安装无 mode 字段 → frp，无感）
  let mode = flags.mode !== undefined ? normalizeMode(flags.mode) : (existingCfg.mode || 'frp')
  const modeErr = validateMode(mode)
  if (modeErr) {
    sayErr(`无效的隧道模式：${flags.mode}`)
    return { action: 'exit', code: 1 }
  }

  const frpConfigured = frpcExists
  const sshConfigured = !!(existingSsh.host && existingSsh.user)
  const modeChanged = flags.mode !== undefined && mode !== existingCfg.mode
  const needsSetup = flags.setup || modeChanged || (mode === 'frp' && !frpConfigured) || (mode === 'ssh' && !sshConfigured)

  if (!needsSetup) return { action: 'skip' }

  let rl = null
  const ensureRl = () => {
    if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout })
    return rl
  }
  try {
    // 交互选模式（仅当未用 --mode 指定且是 TTY）
    if (flags.mode === undefined && !nonTty) {
      console.log('首次配置 dsh-remote-gate：')
      console.log('')
      const picked = await promptField(ensureRl(), {
        label: '模式 (frp / ssh / lan)', defaultValue: mode, required: true, validate: validateMode, normalize: normalizeMode,
      })
      if (picked === undefined) {
        console.log('')
        say('已取消，未写入任何配置。')
        return { action: 'exit', code: 1 }
      }
      mode = picked
    }

    // 该模式的字段集合（lan 无隧道字段，也无需公网域名）
    const specs = mode === 'frp'
      ? [
          { key: 'serverAddr', flagName: '--server', flag: flags.server, label: 'frps 服务器地址', defaultValue: existingFrpc.serverAddr, required: true, validate: validateServer },
          { key: 'serverPort', flagName: '--server-port', flag: flags.serverPort, label: 'frps 服务器端口', defaultValue: existingFrpc.serverPort ?? 7000, required: true, validate: validatePort, coerce: (v) => Number(v) },
          { key: 'authToken', flagName: '--auth-token', flag: flags.authToken, label: 'frps 认证 token', defaultValue: existingFrpc.authToken, required: true, validate: validateToken },
          { key: 'domain', flagName: '--domain', flag: flags.domain, label: '公网域名', defaultValue: existingCfg.domain, required: true, validate: validateDomain, normalize: normalizeDomain },
        ]
      : mode === 'ssh'
        ? [
            { key: 'host', flagName: '--ssh-host', flag: flags.sshHost, label: 'SSH 服务器地址', defaultValue: existingSsh.host, required: true, validate: validateServer },
            { key: 'port', flagName: '--ssh-port', flag: flags.sshPort, label: 'SSH 服务器端口', defaultValue: existingSsh.port ?? 22, required: true, validate: validatePort, coerce: (v) => Number(v) },
            { key: 'user', flagName: '--ssh-user', flag: flags.sshUser, label: 'SSH 用户名', defaultValue: existingSsh.user ?? os.userInfo().username, required: true, validate: validateSshUser },
            { key: 'keyPath', flagName: '--ssh-key', flag: flags.sshKey, label: 'SSH 私钥路径', defaultValue: existingSsh.keyPath ?? defaultSshKeyPath(), required: true, validate: validateSshKeyPath },
            { key: 'domain', flagName: '--domain', flag: flags.domain, label: '公网域名', defaultValue: existingCfg.domain, required: true, validate: validateDomain, normalize: normalizeDomain },
          ]
        : []

    const collected = await collectFields(specs, nonTty, ensureRl())
    if (collected.aborted) {
      console.log('')
      say('已取消，未写入任何配置。')
      return { action: 'exit', code: 1 }
    }
    if (collected.error) return { action: 'exit', code: 1 }
    const values = collected.values

    // 落盘
    if (mode === 'frp') {
      writeFile(FRPC_PATH, renderFrpcToml(values))
      writeFile(CONFIG_PATH, JSON.stringify(mergeDomain({ ...existingCfg, mode: 'frp' }, values.domain), null, 2) + '\n')
    } else if (mode === 'ssh') {
      const nextCfg = {
        ...existingCfg,
        mode: 'ssh',
        domain: values.domain,
        ssh: { host: values.host, port: values.port, user: values.user, keyPath: values.keyPath },
      }
      writeFile(CONFIG_PATH, JSON.stringify(nextCfg, null, 2) + '\n')
    } else {
      // lan：无隧道字段，仅记 mode；保留已有 domain/ssh 等字段便于切回
      writeFile(CONFIG_PATH, JSON.stringify({ ...existingCfg, mode: 'lan' }, null, 2) + '\n')
    }

    // frp 模式：检查 frpc 二进制；ssh 模式：检查 ssh + 连通性自检；lan 模式：无前置条件
    if (mode === 'frp') {
      const frpcName = frpcBinaryName()
      if (!fs.existsSync(path.join(__dirname, 'frp', frpcName))) {
        printFrpcMissingHint(frpcName)
        return { action: 'exit', code: 1 }
      }
    } else if (mode === 'ssh') {
      const check = sshSelfCheck({ host: values.host, port: values.port, user: values.user, keyPath: values.keyPath })
      if (check.status === 'ssh-not-found' || check.status === 'host-key-unverified' || check.status === 'auth-failed') {
        sayErr(`SSH 连通性自检未通过（${check.status}）：${check.hint}`)
        sayErr('配置已保存；修复后直接 npm start 即可，不会再提问。')
        return { action: 'exit', code: 1 }
      }
      if (check.status !== 'ok') {
        say(`提示：SSH 连通性自检未通过（${check.status}）：${check.hint}；已继续启动，隧道会持续重连。`)
      }
    }

    // 汇总一行带过：模式/隧道/域名/落盘文件
    const desc = mode === 'frp'
      ? `frp → ${values.serverAddr}:${values.serverPort}，域名 ${values.domain}`
      : mode === 'ssh'
        ? `ssh → ${values.user}@${values.host}:${values.port}（私钥 ${values.keyPath}），域名 ${values.domain}`
        : 'lan（局域网直连，无隧道）'
    say(`配置完成：${desc}；已写入 config.json` + (mode === 'frp' ? ' 与 frp/frpc.toml' : ''))
    return { action: 'configured' }
  } finally {
    if (rl) rl.close()
  }
}

// ---- IO ------------------------------------------------------------------------
function readFileOr(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function writeFile(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 })
}

// ---- 直接运行（node setup.mjs）--------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  ensureConfigured(process.argv.slice(2)).then((result) => {
    if (result.action === 'exit') process.exit(result.code)
  })
}
