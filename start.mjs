// dsh-remote-gate 一键启动：dsh web + 网关 + 隧道（frp / ssh 反向隧道 / cloudflared）或局域网直连，全部收进当前窗口
//
// 策略：
//   - dsh web：启动前先探 3080，已在运行则跳过；崩溃后自动重启（最多 5 次，间隔 3s）
//   - 网关：退出则整体退出；frpc：退出则整体退出（隧道断了网关不能裸跑）
//   - cloudflared（cf 模式）：致命，退出团灭——重拨必然换新临时域名，旧入口静默失效不如明说
//   - ssh 反向隧道：非致命，退出后自动重拨（弱网/服务器重启不断链）
//   - lan 模式：无隧道，网关绑 0.0.0.0 局域网直连（首次可能弹防火墙提示）
//   - Ctrl+C 同时终止全部（Windows 下对派生树用 taskkill /T）

import { spawn, execFile, execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { ensureConfigured, frpcBinaryName, cloudflaredBinaryName, buildSshReverseArgs, readConfigJson, defaultSshKeyPath } from './setup.mjs'
import { patchDsh } from './patch-dsh.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DSH_PORT = 3080

// frpc 日志过滤：这些是已知无害的告警（如 work connection pool is full），不打印。
const FRPC_IGNORE = ['work connection pool is full']

// cloudflared 日志过滤：quick tunnel 的边框/公告行（URL 由 startCf 抓取后自行打印更干净的登录链接）
const CF_IGNORE = ['Your quick Tunnel has been created', 'trycloudflare.com', '+---', 'Thank you for trying Cloudflare Tunnel']

// 从 cloudflared 输出里抓 quick tunnel 分配的临时域名
const CF_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
function extractCfUrl(line) {
  const m = String(line).match(CF_URL_RE)
  return m ? m[0] : null
}

function shouldIgnoreLine(tag, line) {
  if (tag === 'frpc') return FRPC_IGNORE.some((needle) => line.includes(needle))
  if (tag === 'cf') return CF_IGNORE.some((needle) => line.includes(needle))
  return false
}

const procs = []
let shuttingDown = false

// 日志标签补齐到 8 列（'[setup] ' / '[start] ' / '[gate]  ' / '[dsh]   '），消息列对齐
const padTag = (t) => ('[' + t + ']').padEnd(8)
const say = (t, msg) => console.log(padTag(t) + msg)
const sayErr = (t, msg) => console.error(padTag(t) + msg)

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

function attach(p, tag, onLine) {
  for (const [stream, out] of [[p.stdout, process.stdout], [p.stderr, process.stderr]]) {
    if (!stream) continue
    let buf = ''
    stream.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (onLine) onLine(line)
        if (!shouldIgnoreLine(tag, line)) out.write(`${padTag(tag)}${line.replace(/\r$/, '')}\n`)
      }
    })
    stream.on('end', () => {
      if (buf) {
        if (onLine) onLine(buf)
        if (!shouldIgnoreLine(tag, buf)) out.write(`${padTag(tag)}${buf.replace(/\r$/, '')}\n`)
      }
    })
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
    sayErr('start', '未找到全局安装的 @deepseek-ai/dsh，请先执行 npm install -g @deepseek-ai/dsh')
    return
  }
  const p = spawn(process.execPath, [dshBin, 'web'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  attach(p, 'dsh')
  p.on('error', (err) => sayErr('start', `dsh 启动失败: ${err.message}`))
  p.on('exit', (code, signal) => {
    if (shuttingDown) return
    if (retriesLeft > 0) {
      say('start', `dsh web 退出 (code=${code} signal=${signal})，3s 后重启（剩余重试 ${retriesLeft}）`)
      setTimeout(() => { if (!shuttingDown) startDsh(retriesLeft - 1) }, 3000).unref()
    } else {
      sayErr('start', 'dsh web 反复退出，放弃重启；网关与隧道保持运行（手机端将 502）')
    }
  })
}

function startVital({ tag, cmd, args }) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  attach(p, tag)
  p.on('error', (err) => { sayErr('start', `${tag} 启动失败: ${err.message}`); shutdown(1) })
  p.on('exit', (code, signal) => {
    if (shuttingDown) return
    say('start', `${tag} 退出 (code=${code} signal=${signal})，一并关闭其余进程`)
    shutdown(code ?? 0)
  })
}

// ssh 反向隧道：非致命进程，退出后 3s 自动重拨；连续快速失败给提示但不团灭。
const SSH_RECONNECT_MS = 3000
function startSsh(sshCfg, retryCount = 0) {
  if (!sshCfg || !sshCfg.host || !sshCfg.user) {
    sayErr('start', 'SSH 配置不完整，无法启动隧道；请运行 npm start -- --setup 重新配置')
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
    sayErr('start', `ssh 启动失败: ${err.message}（请确认系统已安装 OpenSSH 客户端）`)
    shutdown(1)
  })
  p.on('exit', (code, signal) => {
    if (shuttingDown) return
    const fast = Date.now() - startedAt < 5000
    const next = fast ? retryCount + 1 : 0
    if (next === 3) {
      say('start', 'ssh 连续快速断开，疑似认证/主机指纹/网络问题（仍会继续重连；私钥见 config.json ssh 字段，首次需先手动 ssh 一次录入指纹）')
    }
    say('start', `ssh 隧道断开 (code=${code} signal=${signal})，${SSH_RECONNECT_MS / 1000}s 后重连`)
    setTimeout(() => { if (!shuttingDown) startSsh(sshCfg, next) }, SSH_RECONNECT_MS).unref()
  })
}

// cf 模式：cloudflared quick tunnel，致命进程（退出团灭）。
// 重拨必然分配新临时域名、旧入口静默失效——与其假装还活着，不如团灭让用户重启拿新链接。
function cloudflaredPath() {
  const p = path.join(__dirname, 'cf', cloudflaredBinaryName())
  return fs.existsSync(p) ? p : null
}

// cloudflared 分配域名通常要几秒，此时网关早已把 token 落盘；仍做短重试兜底竞态
function printCfLoginLink(url, attempt = 0) {
  let cfg = {}
  try { cfg = readConfigJson(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) } catch { }
  if (cfg.token) {
    say('start', `登录链接: ${url}/?t=${cfg.token}`)
    say('start', '注意：cf 临时域名仅本次运行有效，重启后需重新发送新链接到手机')
    return
  }
  if (attempt >= 10) {
    say('start', `cf 域名已分配: ${url}（未读到令牌，登录链接见 [gate] 输出）`)
    return
  }
  setTimeout(() => printCfLoginLink(url, attempt + 1), 500).unref()
}

function startCf() {
  const bin = cloudflaredPath()
  if (!bin) {
    sayErr('start', `未找到 cf/${cloudflaredBinaryName()}；请从 https://github.com/cloudflare/cloudflared/releases 下载（Windows 选 cloudflared-windows-amd64.exe，改名后放入 cf/ 目录）`)
    shutdown(1)
    return
  }
  const p = spawn(bin, ['--no-autoupdate', 'tunnel', '--url', 'http://127.0.0.1:3088'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let announced = false
  attach(p, 'cf', (line) => {
    if (announced) return
    const url = extractCfUrl(line)
    if (!url) return
    announced = true
    printCfLoginLink(url)
  })
  p.on('error', (err) => { sayErr('start', `cloudflared 启动失败: ${err.message}`); shutdown(1) })
  p.on('exit', (code, signal) => {
    if (shuttingDown) return
    say('start', `cf 隧道退出 (code=${code} signal=${signal})，临时域名已失效，一并关闭其余进程（重启后会分配新域名，需重新发链接）`)
    shutdown(code ?? 0)
  })
}

async function main() {
  // 1) 首次运行交互式配置（隧道模式 frp/ssh + 公网域名）；frpc/ssh 缺失或自检失败时退出并提示
  const setup = await ensureConfigured(process.argv.slice(2))
  if (setup.action === 'exit') process.exit(setup.code)
  if (setup.action === 'configured') console.log('')

  // 2) 补丁 DSH client-runtime（修复「提问弹窗被重连刷没」）；幂等，失败不阻断启动；已存在则静默
  const dshWasRunning = await probeDsh()
  const patch = patchDsh()
  if (patch.status === 'patched') {
    say('start', '已补丁 dsh client-runtime（修复提问弹窗被重连刷没）')
    if (dshWasRunning) say('start', '注意：dsh web 已在运行，补丁需重启 dsh 后生效')
  } else if (patch.status === 'missing') {
    say('start', '未找到 dsh client-runtime（可能尚未安装），跳过补丁')
  } else if (patch.status !== 'already') {
    sayErr('start', `dsh 补丁失败（${patch.message}），跳过`)
  }

  // 3) 启动 dsh web（已在运行则跳过）
  if (dshWasRunning) {
    say('start', 'dsh web 已在 3080 运行，跳过启动')
  } else {
    say('start', '启动 dsh web...')
    startDsh()
    // 等 dsh web 就绪（最多 30s），避免网关刚启动时 502
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500))
      if (await probeDsh()) break
      if (i === 19) say('start', '等待 dsh web 超时，仍继续启动网关')
    }
  }
  startVital({ tag: 'gate', cmd: process.execPath, args: [path.join(__dirname, 'gateway.mjs')] })

  // 隧道：frp（致命，退出团灭）/ ssh 反向隧道（非致命，退出自动重拨）/ lan（无隧道，网关直连局域网）/ cf（cloudflared 临时隧道，致命）
  let cfg = {}
  try { cfg = readConfigJson(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) } catch { /* 无配置则默认 frp */ }
  if (cfg.mode === 'ssh') {
    say('start', '模式: ssh（反向隧道，断线自动重拨）')
    startSsh(cfg.ssh || {})
  } else if (cfg.mode === 'lan') {
    say('start', '模式: lan（局域网直连，无隧道；首次若弹防火墙提示请点「允许」）')
  } else if (cfg.mode === 'cf') {
    say('start', '模式: cf（Cloudflare 临时隧道，无需服务器；每次启动域名随机）')
    startCf()
  } else {
    say('start', '模式: frp（隧道）')
    startVital({ tag: 'frpc', cmd: path.join(__dirname, 'frp', frpcBinaryName()), args: ['-c', path.join(__dirname, 'frp', 'frpc.toml')] })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  main()
}

export { shouldIgnoreLine, FRPC_IGNORE, CF_IGNORE, extractCfUrl }
