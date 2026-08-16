// setup.mjs — 首次运行交互式配置（frp 隧道 + 公网域名）
// 纯函数（解析/校验/渲染/合并）可被 test/setup.test.mjs 单测；交互循环只在 ensureConfigured 内触发。
// 由 start.mjs 在启动前调用；也可直接 node setup.mjs 单独跑。

import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRPC_PATH = path.join(__dirname, 'frp', 'frpc.toml')
const CONFIG_PATH = path.join(__dirname, 'config.json')

// ---- CLI 标志 -----------------------------------------------------------------
export function parseArgs(argv) {
  const flags = {
    setup: false,
    server: undefined,
    serverPort: undefined,
    authToken: undefined,
    domain: undefined,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => (i + 1 < argv.length ? argv[++i] : undefined)
    if (a === '--setup') flags.setup = true
    else if (a === '--server') flags.server = next()
    else if (a === '--server-port') flags.serverPort = next()
    else if (a === '--auth-token') flags.authToken = next()
    else if (a === '--domain') flags.domain = next()
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
    '# frpc 配置 — dsh-mobile-mini 网关隧道',
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
    'name = "dsh-mobile"',
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

// ---- 交互辅助 -------------------------------------------------------------------
function printUsage() {
  console.log('用法：npm start [选项]')
  console.log('  --setup              强制进入交互式配置（即使已配置）')
  console.log('  --server <地址>      frps 服务器地址')
  console.log('  --server-port <端口> frps 服务器端口（默认 7000）')
  console.log('  --auth-token <令牌>  frps 认证 token')
  console.log('  --domain <域名>      公网域名（如 dsh.example.com）')
  console.log('  --help, -h           显示帮助')
  console.log('')
  console.log('首次运行时若 frp/frpc.toml 不存在会自动进入交互式配置。')
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
  console.error(`[setup] 未找到 frp/${name}。请从 ${FRP_RELEASES} 下载对应平台 release，`)
  console.error(`[setup] 把 ${name} 放进 frp/ 目录后重新运行 npm start。`)
  console.error('[setup] 配置已写入，下次运行不会再提问。')
}

// ---- 主入口（start.mjs 调用）------------------------------------------------------
export async function ensureConfigured(argv = [], io = {}) {
  const flags = parseArgs(argv)
  if (flags.help) {
    printUsage()
    return { action: 'exit', code: 0 }
  }

  const frpcExists = fs.existsSync(FRPC_PATH)
  const needsSetup = flags.setup || !frpcExists
  if (!needsSetup) return { action: 'skip' }

  // 现有值作默认（--setup 时回车保留）
  const existingFrpc = frpcExists ? readFrpcConfig(readFileOr(FRPC_PATH)) : {}
  const existingCfg = readConfigJson(readFileOr(CONFIG_PATH))

  // 逐项收集：标志优先，否则交互提问
  const values = {}
  const nonTty = io.isTTY === undefined ? !process.stdin.isTTY : !io.isTTY

  const specs = [
    { key: 'serverAddr', flagName: '--server', flag: flags.server, label: 'frps 服务器地址', defaultValue: existingFrpc.serverAddr, required: true, validate: validateServer },
    { key: 'serverPort', flagName: '--server-port', flag: flags.serverPort, label: 'frps 服务器端口', defaultValue: existingFrpc.serverPort ?? 7000, required: true, validate: validatePort, coerce: (v) => Number(v) },
    { key: 'authToken', flagName: '--auth-token', flag: flags.authToken, label: 'frps 认证 token', defaultValue: existingFrpc.authToken, required: true, validate: validateToken },
    { key: 'domain', flagName: '--domain', flag: flags.domain, label: '公网域名', defaultValue: existingCfg.domain, required: true, validate: validateDomain, normalize: normalizeDomain },
  ]

  const missing = []
  for (const spec of specs) {
    if (spec.flag !== undefined) {
      let v = spec.normalize ? spec.normalize(spec.flag) : String(spec.flag).trim()
      const err = spec.validate ? spec.validate(v) : null
      if (err) {
        console.error(`[setup] 标志 ${spec.flagName} 无效：${err}`)
        return { action: 'exit', code: 1 }
      }
      values[spec.key] = spec.coerce ? spec.coerce(v) : v
    } else {
      missing.push(spec)
    }
  }

  // 交互补齐缺失项
  if (missing.length > 0) {
    if (nonTty) {
      console.error('[setup] 未提供完整配置且标准输入不是终端；请用 --server/--auth-token/--domain 标志补全，或交互式运行 npm start。')
      return { action: 'exit', code: 1 }
    }
    console.log('首次配置 dsh-remote-gate：')
    console.log('')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let aborted = false
    try {
      for (const spec of missing) {
        const value = await promptField(rl, spec)
        if (value === undefined) {
          aborted = true
          break
        }
        values[spec.key] = spec.coerce ? spec.coerce(value) : value
      }
    } finally {
      rl.close()
    }
    if (aborted) {
      console.log('')
      console.log('[setup] 已取消，未写入任何配置。')
      return { action: 'exit', code: 1 }
    }
  }

  // 落盘：frpc.toml 全量重写 + config.json 合并 domain
  writeFile(FRPC_PATH, renderFrpcToml(values))
  writeFile(CONFIG_PATH, JSON.stringify(mergeDomain(existingCfg, values.domain), null, 2) + '\n')

  // frpc 可执行文件检查（配置已保存，重跑不会再提问）
  const frpcName = frpcBinaryName()
  if (!fs.existsSync(path.join(__dirname, 'frp', frpcName))) {
    printFrpcMissingHint(frpcName)
    return { action: 'exit', code: 1 }
  }

  console.log('[setup] 配置完成：')
  console.log(`[setup]   frps 地址: ${values.serverAddr}:${values.serverPort}`)
  console.log(`[setup]   公网域名: ${values.domain}`)
  console.log('[setup] 已写入 frp/frpc.toml 与 config.json（网关 token 由 gateway 自动生成）')
  return { action: 'configured' }
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
