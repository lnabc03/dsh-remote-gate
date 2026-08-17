// dsh-remote-gate 一键启动：本地控制面板 + dsh web + 网关 + 隧道（frp / ssh / cloudflared）或局域网直连
//
// 策略：
//   - 控制面板：默认启用（--no-ui 关闭），只绑 127.0.0.1，启动后自动以应用窗口打开；
//     配置/模式切换在面板完成，保存 = 写 config.json + 自动重启网关与隧道（dsh 不动）
//   - dsh web：启动前先探 3080，已在运行则跳过；崩溃后自动重启（最多 5 次，间隔 3s）
//   - 网关：退出则整体退出；frpc：退出则整体退出（隧道断了网关不能裸跑）
//   - cloudflared（cf 模式）：致命，退出团灭——重拨必然换新临时域名，旧入口静默失效不如明说
//   - ssh 反向隧道：非致命，退出后自动重拨（弱网/服务器重启不断链）
//   - lan 模式：无隧道，网关绑 0.0.0.0 局域网直连（首次可能弹防火墙提示）
//   - Ctrl+C 同时终止全部（Windows 下对派生树用 taskkill /T）
//   - 进程代际（gen）：面板触发的重启会使旧进程的退出/重连回调失效，不会被误判为崩溃团灭

import { spawn, execFile, execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import dgram from 'node:dgram'
import { fileURLToPath } from 'node:url'
import {
  parseArgs, frpcBinaryName, cloudflaredBinaryName,
  buildSshReverseArgs, buildSshProbeArgs, analyzeSshResult, attachSshHint,
  defaultSshKeyPath, normalizeMode,
} from './setup.mjs'
import {
  loadConfig, saveConfigAtomic, ensureToken, migrateFrpIntoConfig,
  validatePanelConfig, isConfigured, preflightForMode, applyPanelConfig,
} from './config-lib.mjs'
import { startPanel } from './admin.mjs'
import { patchDsh } from './patch-dsh.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DSH_PORT = 3080

// frpc 日志过滤：这些是已知无害的告警（如 work connection pool is full），不打印。
const FRPC_IGNORE = ['work connection pool is full']

// cloudflared 日志过滤：quick tunnel 的边框/公告行（URL 由 startCf 抓取后自行打印更干净的登录链接）。
// 新版 cloudflared 还会打连通性预检表等「信息框」（ INF | ... / INF +---... 形式），一行正则全部收敛；
// 预检明细与框内容重复，只留 precheck complete 汇总行。
// "canceled by remote with error code 0"：HTTP/2 NO_ERROR，浏览器/边缘正常取消在飞请求
// （跳转掐请求、SSE/WS 重连、手机切网/锁屏），cloudflared 误打 ERR 级别，属已知无害噪声。
const CF_IGNORE = ['Your quick Tunnel has been created', 'trycloudflare.com', 'Thank you for trying Cloudflare Tunnel', 'precheck component=', 'canceled by remote with error code 0']
const CF_IGNORE_RE = / INF [+|]/

// 从 cloudflared 输出里抓 quick tunnel 分配的临时域名
const CF_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
function extractCfUrl(line) {
  const m = String(line).match(CF_URL_RE)
  return m ? m[0] : null
}

function shouldIgnoreLine(tag, line) {
  if (tag === 'frpc') return FRPC_IGNORE.some((needle) => line.includes(needle))
  if (tag === 'cf') return CF_IGNORE_RE.test(line) || CF_IGNORE.some((needle) => line.includes(needle))
  return false
}

// ---- 全局状态 -------------------------------------------------------------------
const procs = []
let shuttingDown = false

const state = {
  cfg: {},
  cfUrl: null,     // cf 模式 cloudflared 分配的临时域名（https://xxx.trycloudflare.com）
  lanIp: null,     // lan 模式探测到的局域网 IP
  dsh: { proc: null, gen: 0, retriesLeft: 5, external: false },
  gate: { proc: null, gen: 0 },
  tunnel: { tag: null, proc: null, gen: 0 },
  panel: null,
}

const procRunning = (p) => !!p && p.exitCode === null && !p.killed

// 日志标签补齐到 8 列（'[setup] ' / '[start] ' / '[gate]  ' / '[dsh]   '），消息列对齐
const padTag = (t) => ('[' + t + ']').padEnd(8)
function emit(tag, msg, toStderr) {
  const line = padTag(tag) + msg
  if (toStderr) console.error(line)
  else console.log(line)
  try { state.panel?.log(tag, msg) } catch { }
}
const say = (t, msg) => emit(t, msg, false)
const sayErr = (t, msg) => emit(t, msg, true)

function killTree(p) {
  // Windows: p.kill() 只杀直接子进程，npx -> node 的派生树需要 taskkill /T
  if (process.platform === 'win32' && p.pid) {
    try { execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], () => { }) } catch { }
  } else {
    try { p.kill() } catch { }
  }
}

// 进程仍存活判定。p.killed 不能用于此——kill() 一调用它就为 true，但进程可能还没死。
const alive = (p) => !!p && p.exitCode === null && p.signalCode === null

// 等子进程真正退出（带超时兜底）。
// 面板热重启必须先等旧进程释放监听端口（网关 3088 / dsh 3080）再拉新进程：
// killTree 在 Windows 走异步 taskkill，一发出就返回；若立即 spawn 新进程，
// 新进程 EADDRINUSE 秒退，命中 exit 回调被误判为「意外崩溃」→ 团灭（踩过）。
function waitExit(p, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!alive(p)) return resolve()
    const t = setTimeout(() => resolve(), timeoutMs)
    t.unref?.()
    p.once('exit', () => { clearTimeout(t); resolve() })
  })
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const p of procs) killTree(p)
  try { state.panel?.close() } catch { }
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
      for (const line of lines) handleLine(tag, line, out, onLine)
    })
    stream.on('end', () => {
      if (buf) handleLine(tag, buf, out, onLine)
    })
  }
  procs.push(p)
  return p
}

function handleLine(tag, rawLine, out, onLine) {
  if (onLine) onLine(rawLine)
  if (shouldIgnoreLine(tag, rawLine)) return
  const clean = rawLine.replace(/\r$/, '')
  out.write(`${padTag(tag)}${clean}\n`)
  try { state.panel?.log(tag, clean) } catch { }
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

// ---- dsh web ---------------------------------------------------------------------
function startDsh() {
  const gen = ++state.dsh.gen
  const dshBin = resolveDshBin()
  if (dshBin === null) {
    sayErr('start', '未找到全局安装的 @deepseek-ai/dsh，请先执行 npm install -g @deepseek-ai/dsh')
    return
  }
  const p = spawn(process.execPath, [dshBin, 'web'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  state.dsh.proc = p
  state.dsh.external = false
  attach(p, 'dsh')
  p.on('error', (err) => { if (gen === state.dsh.gen) sayErr('start', `dsh 启动失败: ${err.message}`) })
  p.on('exit', (code, signal) => {
    if (shuttingDown || gen !== state.dsh.gen) return
    if (state.dsh.retriesLeft > 0) {
      state.dsh.retriesLeft--
      say('start', `dsh web 退出 (code=${code} signal=${signal})，3s 后重启（剩余重试 ${state.dsh.retriesLeft}）`)
      setTimeout(() => { if (!shuttingDown && gen === state.dsh.gen) startDsh() }, 3000).unref()
    } else {
      sayErr('start', 'dsh web 反复退出，放弃重启；网关与隧道保持运行（手机端将 502）')
    }
    state.panel?.broadcastStatus()
  })
  state.panel?.broadcastStatus()
}

// 面板「重启 dsh」：只能重启本启动器拉起的 dsh；外部已运行的 dsh 不归我们管
async function restartDshAction() {
  if (state.dsh.external || !state.dsh.proc) {
    return { ok: false, error: '当前 3080 上的 dsh 不是本启动器拉起的，无法代为重启；请手动重启后重新运行 npm start' }
  }
  say('start', '面板请求重启 dsh web（进行中的 agent 会话会中断）')
  state.dsh.gen++ // 旧进程退出回调失效，不触发自动重启计数
  if (alive(state.dsh.proc)) {
    killTree(state.dsh.proc)
    await waitExit(state.dsh.proc) // 等 3080 释放再拉新，避免新 dsh EADDRINUSE 白耗一次重试
  }
  state.dsh.retriesLeft = 5
  startDsh()
  return { ok: true }
}

// ---- 网关（致命：意外退出团灭；面板重启走 gen 失效，不团灭） --------------------------
function startGate() {
  const gen = ++state.gate.gen
  const p = spawn(process.execPath, [path.join(__dirname, 'gateway.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  state.gate.proc = p
  attach(p, 'gate')
  p.on('error', (err) => {
    if (gen !== state.gate.gen) return
    sayErr('start', `gate 启动失败: ${err.message}`)
    shutdown(1)
  })
  p.on('exit', (code, signal) => {
    if (shuttingDown || gen !== state.gate.gen) return
    say('start', `gate 退出 (code=${code} signal=${signal})，一并关闭其余进程`)
    shutdown(code ?? 0)
  })
  state.panel?.broadcastStatus()
}

async function stopGate() {
  state.gate.gen++ // 使旧进程的退出回调失效（不触发团灭）
  const p = state.gate.proc
  state.gate.proc = null
  if (alive(p)) {
    killTree(p)
    await waitExit(p) // 等 3088 释放：新网关立即 bind 会 EADDRINUSE 秒退 → 误判团灭
  }
}

// ---- 隧道 ---------------------------------------------------------------------------
// frpc / cloudflared 致命（退出团灭）；ssh 非致命（3s 重拨）。gen 同上处理面板重启。
const SSH_RECONNECT_MS = 3000

function startTunnel(cfg) {
  const gen = ++state.tunnel.gen
  const mode = normalizeMode(cfg.mode) || 'frp'
  if (mode === 'ssh') {
    say('start', '模式: ssh（反向隧道，断线自动重拨）')
    state.tunnel.tag = 'ssh'
    startSshProc(cfg.ssh || {}, gen, 0)
  } else if (mode === 'lan') {
    say('start', '模式: lan（局域网直连，无隧道；首次若弹防火墙提示请点「允许」）')
    state.tunnel.tag = null
    state.tunnel.proc = null
    probeLanIp(gen)
  } else if (mode === 'cf') {
    say('start', '模式: cf（Cloudflare 临时隧道，无需服务器；每次启动域名随机）')
    state.tunnel.tag = 'cf'
    state.cfUrl = null
    startCfProc(gen)
  } else {
    say('start', '模式: frp（隧道）')
    state.tunnel.tag = 'frpc'
    const p = spawn(path.join(__dirname, 'frp', frpcBinaryName()), ['-c', path.join(__dirname, 'frp', 'frpc.toml')], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    state.tunnel.proc = p
    attach(p, 'frpc')
    p.on('error', (err) => {
      if (gen !== state.tunnel.gen) return
      sayErr('start', `frpc 启动失败: ${err.message}`)
      shutdown(1)
    })
    p.on('exit', (code, signal) => {
      if (shuttingDown || gen !== state.tunnel.gen) return
      say('start', `frpc 退出 (code=${code} signal=${signal})，一并关闭其余进程`)
      shutdown(code ?? 0)
    })
  }
  state.panel?.broadcastStatus()
}

async function stopTunnel() {
  state.tunnel.gen++
  const p = state.tunnel.proc
  state.tunnel.proc = null
  state.tunnel.tag = null
  if (alive(p)) {
    killTree(p)
    await waitExit(p)
  }
}

// ssh 反向隧道：非致命进程，退出后 3s 自动重拨；连续快速失败给提示但不团灭。
function startSshProc(sshCfg, gen, retryCount) {
  if (!sshCfg || !sshCfg.host || !sshCfg.user) {
    sayErr('start', 'SSH 配置不完整，无法启动隧道；请在控制面板中补齐 ssh 字段')
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
  state.tunnel.proc = p
  attach(p, 'ssh')
  p.on('error', (err) => {
    if (gen !== state.tunnel.gen) return
    // ssh 非致命（约束 7）：客户端缺失只打提示，隧道状态灯变红，不团灭
    sayErr('start', `ssh 启动失败: ${err.message}（请确认系统已安装 OpenSSH 客户端）`)
    state.panel?.broadcastStatus()
  })
  p.on('exit', (code, signal) => {
    if (shuttingDown || gen !== state.tunnel.gen) return
    const fast = Date.now() - startedAt < 5000
    const next = fast ? retryCount + 1 : 0
    if (next === 3) {
      say('start', 'ssh 连续快速断开，疑似认证/主机指纹/网络问题（仍会继续重连；私钥见 config.json ssh 字段，首次需先手动 ssh 一次录入指纹）')
    }
    say('start', `ssh 隧道断开 (code=${code} signal=${signal})，${SSH_RECONNECT_MS / 1000}s 后重连`)
    state.panel?.broadcastStatus()
    setTimeout(() => { if (!shuttingDown && gen === state.tunnel.gen) startSshProc(sshCfg, gen, next) }, SSH_RECONNECT_MS).unref()
  })
}

// cf 模式：cloudflared quick tunnel，致命进程（退出团灭）。
// 重拨必然分配新临时域名、旧入口静默失效——与其假装还活着，不如团灭让用户重启拿新链接。
function cloudflaredPath() {
  const p = path.join(__dirname, 'cf', cloudflaredBinaryName())
  return fs.existsSync(p) ? p : null
}

function startCfProc(gen) {
  const bin = cloudflaredPath()
  if (!bin) {
    sayErr('start', `未找到 cf/${cloudflaredBinaryName()}；下载指引见控制面板或 cf/README.md`)
    shutdown(1)
    return
  }
  const p = spawn(bin, ['--no-autoupdate', 'tunnel', '--url', 'http://127.0.0.1:3088'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  state.tunnel.proc = p
  let announced = false
  attach(p, 'cf', (line) => {
    if (announced) return
    const url = extractCfUrl(line)
    if (!url) return
    announced = true
    state.cfUrl = url
    printCfLoginLink(url)
    state.panel?.broadcastStatus()
  })
  p.on('error', (err) => {
    if (gen !== state.tunnel.gen) return
    sayErr('start', `cloudflared 启动失败: ${err.message}`)
    shutdown(1)
  })
  p.on('exit', (code, signal) => {
    if (shuttingDown || gen !== state.tunnel.gen) return
    say('start', `cf 隧道退出 (code=${code} signal=${signal})，临时域名已失效，一并关闭其余进程（重启后会分配新域名，需重新发链接）`)
    shutdown(code ?? 0)
  })
}

function printCfLoginLink(url) {
  const token = state.cfg.token
  if (token) {
    say('start', `登录链接: ${url}/?t=${token}`)
    say('start', '注意：cf 临时域名仅本次运行有效，重启后需重新发送新链接到手机')
  } else {
    say('start', `cf 域名已分配: ${url}（未读到令牌，登录链接见 [gate] 输出）`)
  }
}

// 探测局域网 IP：用 UDP connect 让操作系统选出「默认路由所在网卡」的地址（不真的发包）。
// 直接取枚举第一个会踩中 VMware/Hyper-V 等虚拟网卡——那种地址手机永远够不到（踩过）。
function lanCandidates() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (!iface.internal && (iface.family === 'IPv4' || iface.family === 4)) out.push(iface.address)
    }
  }
  return out
}

function probeLanIp(gen) {
  try {
    const s = dgram.createSocket('udp4')
    const done = (addr) => {
      if (gen === state.tunnel.gen && addr) {
        state.lanIp = addr
        state.panel?.broadcastStatus()
      }
    }
    s.on('error', () => done(lanCandidates()[0]))
    s.connect(80, '192.0.2.1', () => { // TEST-NET-1，仅触发路由选择
      let addr
      try { addr = s.address().address } catch { }
      s.close()
      done(addr || lanCandidates()[0])
    })
  } catch {
    state.lanIp = lanCandidates()[0] || null
  }
}

// ---- 面板动作（admin.mjs 的 API 回调） ----------------------------------------------
function loginLink() {
  const cfg = state.cfg
  const token = cfg.token
  if (!token) return null
  const mode = normalizeMode(cfg.mode)
  if (mode === 'lan') {
    return state.lanIp ? `http://${state.lanIp}:3088/?t=${token}` : null
  }
  if (mode === 'cf') {
    return state.cfUrl ? `${state.cfUrl}/?t=${token}` : null
  }
  if (mode === 'frp' || mode === 'ssh') {
    return cfg.domain ? `https://${cfg.domain}/?t=${token}` : null
  }
  return null
}

const actions = {
  getStatus() {
    return {
      mode: normalizeMode(state.cfg.mode) || null,
      configured: isConfigured(state.cfg),
      login: loginLink(),
      cfPending: normalizeMode(state.cfg.mode) === 'cf' && procRunning(state.tunnel.proc) && !state.cfUrl,
      procs: {
        dsh: { running: procRunning(state.dsh.proc) || state.dsh.external, owned: !state.dsh.external && !!state.dsh.proc },
        gate: { running: procRunning(state.gate.proc) },
        tunnel: { tag: state.tunnel.tag, running: procRunning(state.tunnel.proc) },
      },
      ports: { panel: state.panel?.port ?? null, gate: 3088, dsh: DSH_PORT },
    }
  },
  getConfig() {
    // 本机面板（令牌鉴权 + 仅 127.0.0.1），配置含敏感字段原样返回供编辑
    return state.cfg
  },
  async saveConfig(payload) {
    const { errors, config } = validatePanelConfig(payload, state.cfg)
    if (errors) return { ok: false, errors }
    const pre = preflightForMode(config.mode)
    if (!pre.ok) return { ok: false, errors: { mode: pre.hint } }
    const oldToken = state.cfg.token
    applyPanelConfig(config)
    state.cfg = config
    say('start', `配置已保存（模式: ${config.mode}），重启网关与隧道…`)
    await Promise.all([stopTunnel(), stopGate()]) // 等旧进程退出释放端口，再拉新进程
    startGate()
    startTunnel(config)
    // ssh 模式：保存后异步跑一次连通性自检，结果只进日志不阻塞保存
    if (normalizeMode(config.mode) === 'ssh' && config.ssh) runSshSelfCheck(config.ssh)
    return { ok: true, newToken: config.token !== oldToken ? config.token : undefined }
  },
  async restartDsh() {
    return restartDshAction()
  },
}

function runSshSelfCheck(sshCfg) {
  const args = buildSshProbeArgs({
    host: sshCfg.host, port: sshCfg.port ?? 22, user: sshCfg.user, keyPath: sshCfg.keyPath ?? defaultSshKeyPath(),
  })
  execFile('ssh', args, { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
    const result = attachSshHint(analyzeSshResult({
      status: err ? (typeof err.code === 'number' ? err.code : 255) : 0,
      stderr: String(stderr || ''),
      spawnError: err && typeof err.code === 'string' ? err.message : '',
    }), sshCfg)
    if (result.status === 'ok') say('start', 'SSH 连通性自检通过')
    else sayErr('start', `SSH 连通性自检未通过（${result.status}）：${result.hint}`)
  })
}

// ---- 自动打开面板（--app 应用窗口优先，找不到 Chrome/Edge 回退默认浏览器） -----------------
export function appBrowserCandidates(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return []
  const pf = env['ProgramFiles'] || 'C:\\Program Files'
  const pfx = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const la = env.LOCALAPPDATA || ''
  const out = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  if (la) out.unshift(path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  return out
}

function openInBrowser(url) {
  if (process.env.DSH_GATE_NO_OPEN) return
  try {
    if (process.platform === 'win32') {
      for (const bin of appBrowserCandidates()) {
        if (fs.existsSync(bin)) {
          // --app=：无地址栏/标签页的独立窗口，接近原生应用体验
          spawn(bin, ['--app=' + url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          say('start', `已用应用窗口打开控制面板（${path.basename(bin)}）`)
          return
        }
      }
      spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      say('start', '已在默认浏览器打开控制面板')
      return
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref()
    say('start', '已在默认浏览器打开控制面板')
  } catch {
    say('start', '自动打开浏览器失败，请手动复制上面的面板地址访问')
  }
}

function printStartUsage() {
  console.log('用法：npm start [--no-ui]')
  console.log('  默认启动本地控制面板（127.0.0.1 随机空闲端口，自动打开应用窗口），')
  console.log('  配置/模式切换/二维码/日志均在面板中完成。')
  console.log('  --no-ui    不启动面板，纯命令行运行（无浏览器环境/调试用）')
  console.log('  --help, -h 显示帮助')
}

// ---- 主流程 ---------------------------------------------------------------------------
async function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.help) { printStartUsage(); return }

  // 1) 配置：老安装的 frpc.toml 参数迁入 config.json；确保令牌存在（面板登录要用）
  let cfg = loadConfig()
  const mig = migrateFrpIntoConfig(cfg)
  if (mig.migrated) {
    cfg = mig.cfg
    saveConfigAtomic(cfg)
    say('start', '已将 frp/frpc.toml 的参数迁入 config.json（frpc.toml 今后只是生成产物，勿手动编辑）')
  }
  cfg = ensureToken(cfg).cfg
  state.cfg = cfg

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

  // 3) 启动 dsh web（已在运行则跳过，且外部 dsh 不归面板重启按钮管）
  if (dshWasRunning) {
    state.dsh.external = true
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

  // 4) 网关 + 隧道（未配置则等面板里填好再拉起；隧道二进制缺失同理）
  if (!isConfigured(cfg)) {
    say('start', '尚未完成访问模式配置，请在控制面板中填写（保存后会自动拉起网关与隧道）')
  } else {
    const pre = preflightForMode(normalizeMode(cfg.mode) || 'frp')
    if (!pre.ok) {
      sayErr('start', pre.hint)
      sayErr('start', '网关与隧道未启动；修复后在控制面板重新保存配置即可')
    } else {
      startGate()
      startTunnel(cfg)
    }
  }

  // 5) 控制面板（默认）：只绑 127.0.0.1，复用网关令牌登录
  if (!flags.noUi) {
    try {
      state.panel = await startPanel({
        getToken: () => state.cfg.token,
        actions,
        preferredPort: Number(process.env.DSH_GATE_PANEL_PORT || 3089),
      })
      say('start', `控制面板: ${state.panel.url}`)
      openInBrowser(state.panel.url)
    } catch (err) {
      sayErr('start', `控制面板启动失败: ${err.message}（继续以纯命令行模式运行）`)
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  main()
}

export { shouldIgnoreLine, FRPC_IGNORE, CF_IGNORE, CF_IGNORE_RE, extractCfUrl, waitExit }
