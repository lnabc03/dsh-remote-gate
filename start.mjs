// dsh-mobile-mini 一键启动：dsh web + 网关 + 隧道（frp 或 ssh 反向隧道），全部收进当前窗口
//
// 策略：
//   - dsh web：启动前先探 3080，已在运行则跳过；崩溃后自动重启（最多 5 次，间隔 3s）
//   - 网关：退出则整体退出；frpc：退出则整体退出（隧道断了网关不能裸跑）
//   - ssh 反向隧道：非致命，退出后自动重拨（弱网/服务器重启不断链）
//   - Ctrl+C 同时终止全部（Windows 下对派生树用 taskkill /T）

import { spawn, execFile, execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { ensureConfigured, frpcBinaryName, buildSshReverseArgs, readConfigJson, defaultSshKeyPath } from './setup.mjs'
import { patchDsh } from './patch-dsh.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DSH_PORT = 3080

// frpc 日志过滤：这些是已知无害的告警（如 work connection pool is full），不打印。
const FRPC_IGNORE = ['work connection pool is full']

function shouldIgnoreLine(tag, line) {
  if (tag !== 'frpc') return false
  return FRPC_IGNORE.some((needle) => line.includes(needle))
}

const procs = []
let shuttingDown = false

function killTree(p) {
  // Windows: p.kill() 只杀直接子进程，npx -> node 的派生树需要 taskkill /T
  if (process.platform === 'win32' && p.pid) {
    try { execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => { }) } catch { }
  } else {
    try { p.kill() } catch { }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const p of procs) killTree(p)
  setTimeout(() => process.exit(code), 500).unref()
}

function attach(p, tag) {
  for (const [stream, out] of [[p.stdout, process.stdout], [p.stderr, process.stderr]]) {
    if (!stream) continue
    let buf = ''
    stream.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) if (!shouldIgnoreLine(tag, line)) out.write(`[${tag}] ${line}\n`)
    })
    stream.on('end', () => { if (buf && !shouldIgnoreLine(tag, buf)) out.write(`[${tag}] ${buf}\n`) })
  }
  procs.push(p)
  return p
}

function probeDsh() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: DSH_PORT, path: '/', timeout: 1500 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// 定位全局安装的 @deepseek-ai/dsh 的 bin.js（不经过 npx/shell 中转，避免派生树残留）
let dshBinCache
function resolveDshBin() {
  if (dshBinCache !== undefined) return dshBinCache
  const candidates = []
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN)
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim()
    if (root) candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  } catch { /* fall through */ }
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) { dshBinCache = c; return c }
  }
  dshBinCache = null
  return null
}

function startDsh(retriesLeft = 5) {
  const dshBin = resolveDshBin()
  if (dshBin === null) {
    console.error('[start] 未找到全局安装的 @deepseek-ai/dsh，请先执行 npm install -g @deepseek-ai/dsh')
    return
  }
  const p = spawn(process.execPath, [dshBin, 'web'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  attach(p, 'dsh')
  p.on('error', (err) => console.error(`[start] dsh 启动失败: ${err.message}`))
  p.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (retriesLeft > 0) {
      console.log(`[start] dsh web 退出 (code=${code} signal=${signal})，3s 后重启（剩余重试 ${retriesLeft}）`)
      setTimeout(() => { if (!shuttingDown) startDsh(retriesLeft - 1) }, 3000).unref()
    } else {
      console.error('[start] dsh web 反复退出，放弃重启；网关与隧道保持运行（手机端将 502）')
    }
  })
}

function startVital({ tag, cmd, args }) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  attach(p, tag)
  p.on('error', (err) => { console.error(`[start] ${tag} 启动失败: ${err.message}`); shutdown(1) })
  p.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.log(`[start] ${tag} 退出 (code=${code} signal=${signal})，一并关闭其余进程`)
    shutdown(code ?? 0)
  })
}

// ssh 反向隧道：非致命进程，退出后 3s 自动重拨；连续快速失败给提示但不团灭。
const SSH_RECONNECT_MS = 3000
function startSsh(sshCfg, retryCount = 0) {
  if (!sshCfg || !sshCfg.host || !sshCfg.user) {
    console.error('[start] SSH 配置不完整，无法启动隧道；请运行 npm start -- --setup 重新配置')
    shutdown(1)
    return
  }
  const args = buildSshReverseArgs({
    host: sshCfg.host,
    port: sshCfg.port ?? 22,
    user: sshCfg.user,
    keyPath: sshCfg.keyPath ?? defaultSshKeyPath(),
    remotePort: 3088,
    localPort: 3088,
  })
  const startedAt = Date.now()
  const p = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  attach(p, 'ssh')
  p.on('error', (err) => {
    console.error(`[start] ssh 启动失败: ${err.message}（请确认系统已安装 OpenSSH 客户端）`)
    shutdown(1)
  })
  p.on('exit', (code, signal) => {
    if (shuttingDown) return
    const fast = Date.now() - startedAt < 5000
    const next = fast ? retryCount + 1 : 0
    if (next === 3) {
      console.log('[start] ssh 连续快速断开，疑似认证/主机指纹/网络问题；仍会继续重连')
      console.log('[start]   私钥/用户名见 config.json 的 ssh 字段；首次连接需先手动 ssh 一次录入主机指纹')
    }
    console.log(`[start] ssh 隧道断开 (code=${code} signal=${signal})，${SSH_RECONNECT_MS / 1000}s 后重连`)
    setTimeout(() => { if (!shuttingDown) startSsh(sshCfg, next) }, SSH_RECONNECT_MS).unref()
  })
}

async function main() {
  // 1) 首次运行交互式配置（隧道模式 frp/ssh + 公网域名）；frpc/ssh 缺失或自检失败时退出并提示
  const setup = await ensureConfigured(process.argv.slice(2))
  if (setup.action === 'exit') process.exit(setup.code)
  if (setup.action === 'configured') console.log('')

  // 2) 补丁 DSH client-runtime（修复「提问弹窗被重连刷没」）；幂等，失败不阻断启动
  const dshWasRunning = await probeDsh()
  const patch = patchDsh()
  if (patch.status === 'patched') {
    console.log(`[start] 已补丁 DSH client-runtime：${patch.path}`)
    if (dshWasRunning) console.log('[start] 注意：dsh web 已在运行，补丁需重启 dsh 后生效')
  } else if (patch.status === 'already') {
    console.log(`[start] DSH client-runtime 补丁已存在：${patch.path}`)
  } else if (patch.status === 'missing') {
    console.log('[start] 未找到 DSH client-runtime（可能尚未安装），跳过补丁；提问弹窗问题可能仍存在')
  } else {
    console.log(`[start] DSH 补丁失败（${patch.message}），跳过；提问弹窗问题可能仍存在`)
  }

  // 3) 启动 dsh web（已在运行则跳过）
  if (dshWasRunning) {
    console.log('[start] 检测到 dsh web 已在 3080 运行，跳过启动')
  } else {
    console.log('[start] 启动 dsh web...')
    startDsh()
    // 等 dsh web 就绪（最多 30s），避免网关刚启动时 502
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500))
      if (await probeDsh()) break
      if (i === 19) console.log('[start] 等待 dsh web 超时，仍继续启动网关')
    }
  }
  startVital({ tag: 'gate', cmd: process.execPath, args: [path.join(__dirname, 'gateway.mjs')] })

  // 隧道：frp（致命，退出团灭）或 ssh 反向隧道（非致命，退出自动重拨）
  let cfg = {}
  try { cfg = readConfigJson(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) } catch { /* 无配置则默认 frp */ }
  if (cfg.mode === 'ssh') {
    console.log('[start] 隧道模式：ssh 反向隧道')
    startSsh(cfg.ssh || {})
  } else {
    console.log('[start] 隧道模式：frp')
    startVital({ tag: 'frpc', cmd: path.join(__dirname, 'frp', frpcBinaryName()), args: ['-c', path.join(__dirname, 'frp', 'frpc.toml')] })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  main()
}

export { shouldIgnoreLine, FRPC_IGNORE }
