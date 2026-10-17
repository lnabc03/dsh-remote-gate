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
//   - Ctrl+C 同时终止全部（Windows 下对派生树用 taskkill /T），并关闭面板应用窗口
//   - 面板看门狗（watchdog.mjs，detached）：控制台被 X / 崩溃时 Node 收不到任何信号，
//     由看门狗发现父进程死亡后关闭面板窗口，避免面板静默挂着
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
  validatePanelConfig, isConfigured, preflightForMode, applyPanelConfig, syncFrpcToml,
} from './config-lib.mjs'
import { startPanel } from './admin.mjs'
import { killPanelBrowser, panelPidFile } from './watchdog.mjs'

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

// dsh >= 0.2 自带浏览器会话认证：`dsh web` 启动时会打印一行
//   dsh web: http://127.0.0.1:3080/?token=<启动令牌> (LAN: http://<ip>:3080/?token=<同一个>)
// 远端设备必须先用这个一次性令牌访问根路径，才能换到 dsh-auth-* 会话 Cookie——否则网关
// 转发出去的每个请求都被 dsh 401（网关把 Host 改写成 127.0.0.1:3080 已不再足够，因为本机
// 浏览器同样要出示 Cookie）。网关进程拿不到子进程的 stdout，所以由这里抓取后落盘，
// 网关按 mtime 懒读（gateway.mjs 的 DSH_TOKEN_FILE）。令牌每次 dsh 启动都会变，落盘后
// 面板的「重启 dsh」也不需要重启网关。
const DSH_TOKEN_FILE = path.join(__dirname, '.dsh-web-token')
const DSH_WEB_LINE_RE = /dsh web:\s+https?:\/\/\S+?[?&]token=([A-Za-z0-9_-]+)/
function extractDshLaunchToken(line) {
  const m = String(line).match(DSH_WEB_LINE_RE)
  return m ? m[1] : null
}

// 只写不读：令牌是 dsh 进程的瞬时凭证，重启即失效，落盘只为跨进程交给网关。
function rememberDshLaunchToken(line) {
  const tok = extractDshLaunchToken(line)
  if (tok === null || tok === state.dshToken) return
  state.dshToken = tok
  try {
    fs.writeFileSync(DSH_TOKEN_FILE, tok + '\n', { mode: 0o600 })
  } catch (err) {
    // 写不进去不阻断启动：远端会退回「dsh 自己的 401 页」，本机访问不受影响
    sayErr('start', `dsh 启动令牌写入失败: ${err && err.message ? err.message : err}；远端登录会 401`)
    return
  }
  say('start', '已捕获 dsh 启动令牌')
}

function dropDshLaunchToken() {
  state.dshToken = null
  try { fs.unlinkSync(DSH_TOKEN_FILE) } catch { /* 本来就没有 */ }
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
  dshToken: null,  // 从 dsh stdout 抓到的启动令牌（见 rememberDshLaunchToken）
  panelBrowserPid: null, // 本进程开出来的面板浏览器 pid（关窗只关自己开的，见 shutdown）
  gate: { proc: null, gen: 0 },
  tunnel: { tag: null, proc: null, gen: 0 },
  panel: null,
  watchdog: null,  // 面板看门狗子进程（detached，见 watchdog.mjs）
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
  // 面板窗口必须**真的关掉**再退出。killPanelBrowser 要起 PowerShell + 1.5s 关窗宽限，
  // 整个过程 ≈2s；原来这里 fire-and-forget 却在 500ms 后就 process.exit，等于把负责关窗的
  // 子进程一起掐死——于是每次都留下一个 --app 空白窗口：没有工具栏（--app 模式）、只有背景色
  // （页面服务已死）、标题退化成 "127.0.0.1"，用户完全认不出是什么，也关不掉（踩过）。
  // 另外看门狗要留到最后杀：它是关窗的最后一道保险。
  const watchdog = state.watchdog
  state.watchdog = null
  for (const p of procs) killTree(p)
  dropDshLaunchToken() // 令牌随 dsh 一起失效，别留给下一次 start:gateway-only 误用
  try { state.panel?.close() } catch { }
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (watchdog) killTree(watchdog)
    // 非零退出时别让控制台一闪而过：start.bat 用 /min 拉起，窗口一关就只剩「闪退」，
    // 用户连报错都看不到。多留 60 秒（最小化状态下也能还原窗口看日志），回车或超时即退。
    if (code !== 0 && process.stdin.isTTY && !process.env.DSH_GATE_NO_PAUSE) {
      sayErr('start', '启动失败，原因见上（同见 start-crash.log）；60 秒后关闭，回车立即关闭')
      const bail = () => process.exit(code)
      try { process.stdin.resume() } catch { }
      process.stdin.once('data', bail)
      setTimeout(bail, 60_000)
      return
    }
    process.exit(code)
  }
  if (watchdog) say('start', '关闭面板窗口…')
  // 只关「本进程自己开出来的」面板窗口：没有记录 pid 说明根本没开成窗，或者窗属于
  // 另一个正在运行的实例（同 profile 时 Edge 会把命令交给既有实例）。这时硬去按
  // profile 扫杀，会把别人好端端的面板窗口关掉。
  const closeOwn = state.panelBrowserPid === null
    ? Promise.resolve()
    : killPanelBrowser(panelProfileDir()).catch(() => { })
  Promise.race([closeOwn, new Promise((r) => setTimeout(r, 5000))]).then(finish, finish)
  setTimeout(finish, 6000) // 兜底：killPanelBrowser 卡住也不会永远退不掉
}

// ---- 启动崩溃可见性 ---------------------------------------------------------------
// start.bat 以「最小化控制台」拉起本进程：任何早期崩溃都会连窗口一起无声消失，
// 双击后「什么都没发生」无法排查。因此致命错误一律追加写入 start-crash.log（仓库目录，
// 已 gitignore），内容含时间、node 版本、平台与堆栈；控制台同步打印一行。
const CRASH_LOG = path.join(__dirname, 'start-crash.log')
let crashHandled = false

// 隧道致命退出（frpc/cloudflared 退出 = 团灭）会连控制台一起关掉——start.bat 用 /min
// 拉起的窗口一没，用户只看到「闪退」，什么线索都不剩。所以：
//   1) 记住每个隧道的最近若干行输出（去掉 ANSI 色码），退出时落进 start-crash.log；
//   2) 非零退出且当前是 TTY 时，把控制台多留 60 秒，让人来得及还原窗口看日志。
const LOG_TAIL = new Map()
const LOG_TAIL_MAX = 20
export function rememberTail(tag, line) {
  if (tag !== 'frpc' && tag !== 'cf') return
  const buf = LOG_TAIL.get(tag) || []
  buf.push(String(line).replace(/\r$/, '').replace(/\u001b\[[0-9;]*m/g, ''))
  if (buf.length > LOG_TAIL_MAX) buf.shift()
  LOG_TAIL.set(tag, buf)
  return buf
}
/** 纯函数：拼一条非崩溃致命记录（时间戳/版本可注入，便于测试）。 */
export function formatFatalNote(origin, reason, tail, now = new Date().toISOString(),
  version = process.version, platform = process.platform) {
  const lines = [`[${now}] ${origin} (node ${version}, ${platform})`, reason]
  if (tail && tail.length) lines.push('--- 最近输出 ---', ...tail)
  return lines.join('\n') + '\n\n'
}
/** 把一条「非崩溃」的致命原因追加到 start-crash.log（窗口关了也能事后查）。 */
export function appendFatalNote(origin, reason, tail) {
  try { fs.appendFileSync(CRASH_LOG, formatFatalNote(origin, reason, tail)) } catch { }
}

export function formatCrash(err, origin, version = process.version, platform = process.platform) {
  const stack = err && err.stack ? err.stack : String(err)
  return `[${new Date().toISOString()}] ${origin} (node ${version}, ${platform})\n${stack}\n\n`
}
function fatalCrash(err, origin) {
  if (crashHandled) return
  crashHandled = true
  try { fs.appendFileSync(CRASH_LOG, formatCrash(err, origin)) } catch { }
  sayErr('start', `致命错误（详见 start-crash.log）: ${err && err.message ? err.message : err}`)
  shutdown(1)
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
  rememberTail(tag, rawLine)
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
    const root = execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()
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
    sayErr('start', '未找到全局 dsh；先 npm install -g @deepseek-ai/dsh')
    return
  }
  // --no-open：dsh 0.2 起 `dsh web` 默认会在启动后打开默认浏览器的自身 UI。本启动器的
  // 唯一界面是控制面板，多弹一个标签页纯属噪声（且它会带着 ?token= 直接进 dsh 自己的会话）。
  // 先作废旧令牌：新 dsh 的令牌要等它 bind 完才打印，这期间网关不该拿一个必然失效的值去换 Cookie。
  dropDshLaunchToken()
  const p = spawn(process.execPath, [dshBin, 'web', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  state.dsh.proc = p
  state.dsh.external = false
  // onLine：第一时间从 stdout 抓 `dsh web: ...?token=` 交给网关（见 rememberDshLaunchToken）
  attach(p, 'dsh', rememberDshLaunchToken)
  p.on('error', (err) => { if (gen === state.dsh.gen) sayErr('start', `dsh 启动失败: ${err.message}`) })
  p.on('exit', (code, signal) => {
    if (shuttingDown || gen !== state.dsh.gen) return
    if (state.dsh.retriesLeft > 0) {
      state.dsh.retriesLeft--
      say('start', `dsh web 退出 (code=${code} signal=${signal})，3s 后重启（剩余重试 ${state.dsh.retriesLeft}）`)
      setTimeout(() => { if (!shuttingDown && gen === state.dsh.gen) startDsh() }, 3000).unref()
    } else {
      sayErr('start', 'dsh web 反复退出，放弃重启；网关与隧道继续运行，远端将 502')
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
  say('start', '重启 dsh web（agent 会话会中断）')
  state.dsh.gen++ // 旧进程退出回调失效，不触发自动重启计数
  if (alive(state.dsh.proc)) {
    killTree(state.dsh.proc)
    await waitExit(state.dsh.proc) // 等 3080 释放再拉新，避免新 dsh EADDRINUSE 白耗一次重试
  }
  dropDshLaunchToken() // 旧令牌随旧进程作废；新 dsh 一打印就重新落盘
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
    if (code === 2) {
      // 网关用退出码 2 表示「端口被占」——是环境残留，不是本程序崩溃，给出的提示也不同
      sayErr('start', '网关端口被占用，已停止全部进程')
      shutdown(code)
      return
    }
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
    say('start', '模式: ssh（断线自动重拨）')
    state.tunnel.tag = 'ssh'
    startSshProc(cfg.ssh || {}, gen, 0)
  } else if (mode === 'lan') {
    say('start', '模式: lan（局域网直连；防火墙弹窗选「允许」）')
    state.tunnel.tag = null
    state.tunnel.proc = null
    probeLanIp(gen)
  } else if (mode === 'cf') {
    say('start', '模式: cf（临时隧道，域名每次随机）')
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
    // 令牌不匹配是最常见的 frp 团灭原因（换服务器后几乎必踩），原文是英文且被团灭日志淹没，
    // 这里补一句能照着改的中文提示（只提示一次，这条错误会连打两遍）。
    let tokenHinted = false
    attach(p, 'frpc', (line) => {
      if (tokenHinted) return
      if (/token in login doesn't match/i.test(line)) {
        tokenHinted = true
        sayErr('start', 'frp token 与服务器不一致；改成 frps.toml 的 auth.token 后重试')
      }
    })
    p.on('error', (err) => {
      if (gen !== state.tunnel.gen) return
      sayErr('start', `frpc 启动失败: ${err.message}`)
      appendFatalNote('frpc 启动失败', err.message)
      shutdown(1)
    })
    p.on('exit', (code, signal) => {
      if (shuttingDown || gen !== state.tunnel.gen) return
      // 落盘再退出：窗口马上要被团灭关掉，这是唯一留下的线索
      appendFatalNote('frpc 意外退出',
        `code=${code} signal=${signal}；frpc 退出即全栈退出，已停止其余进程。`,
        LOG_TAIL.get('frpc'))
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
    sayErr('start', 'ssh 配置不完整；在面板补齐 ssh 字段')
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
    sayErr('start', `ssh 启动失败: ${err.message}（需 OpenSSH 客户端）`)
    state.panel?.broadcastStatus()
  })
  p.on('exit', (code, signal) => {
    if (shuttingDown || gen !== state.tunnel.gen) return
    const fast = Date.now() - startedAt < 5000
    const next = fast ? retryCount + 1 : 0
    if (next === 3) {
      say('start', 'ssh 反复快速断开（认证/主机指纹/网络）；仍会重连，首次需先手动 ssh 一次录入指纹')
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
    sayErr('start', `未找到 cf/${cloudflaredBinaryName()}；见 cf/README.md`)
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
    appendFatalNote('cloudflared 意外退出',
      `code=${code} signal=${signal}；域名随 cloudflared 失效，已停止其余进程。`,
      LOG_TAIL.get('cf'))
    say('start', `cf 隧道退出 (code=${code} signal=${signal})，域名失效，已停止其余进程；重启会换新域名`)
    shutdown(code ?? 0)
  })
}

function printCfLoginLink(url) {
  const token = state.cfg.token
  if (token) {
    say('start', `登录链接: ${url}/?t=${token}`)
    say('start', 'cf 域名仅本次有效，重启后需重发链接')
  } else {
    say('start', `cf 域名: ${url}（未读到令牌，链接见 [gate]）`)
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

// 「打开 DSH 页面」要用的本地地址。dsh 0.2 起 `dsh web` 对 `/` 与 `/api` 都要求
// dsh-auth-* 会话（约束 12），直接开 http://127.0.0.1:3080 只会得到 401 —— 面板那个
// 按钮就踩这个。把一次性启动令牌拼上去，dsh 会种好 Cookie 再 303 回干净的 `./`。
// 令牌取本进程抓到的（state.dshToken）或落盘文件；外部已运行的 dsh 抓不到令牌，
// 只能给裸地址（会 401，属已知限制）。
function currentDshToken() {
  if (state.dshToken) return state.dshToken
  try { return fs.readFileSync(DSH_TOKEN_FILE, 'utf8').trim() || null } catch { return null }
}
export function dshPageUrl(port, token) {
  return `http://127.0.0.1:${port}/` + (token ? `?token=${encodeURIComponent(token)}` : '')
}

const actions = {
  getStatus() {
    return {
      mode: normalizeMode(state.cfg.mode) || null,
      configured: isConfigured(state.cfg),
      login: loginLink(),
      dshUrl: dshPageUrl(DSH_PORT, currentDshToken()),
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
    if (result.status === 'ok') say('start', 'SSH 自检通过')
    else sayErr('start', `SSH 自检未通过（${result.status}）：${result.hint}`)
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

// 面板应用窗口默认尺寸；DSH_GATE_PANEL_WINSIZE="宽x高"（如 1600x900）覆盖
export function panelWindowSize(env = process.env) {
  const m = /^\s*(\d{3,4})\s*[x,]\s*(\d{3,4})\s*$/.exec(env.DSH_GATE_PANEL_WINSIZE || '')
  return { w: m ? +m[1] : 1440, h: m ? +m[2] : 860 }
}

// 面板应用窗口专用 Edge 配置目录（隔离主配置，避免 --window-size 被已保存的窗口位置覆盖）
export function panelProfileDir() {
  const base = process.env.LOCALAPPDATA || os.tmpdir()
  return path.join(base, 'dsh-remote-gate', 'panel-profile')
}

// 清除已保存的窗口位置，确保下次 --window-size 生效
export function clearSavedWindowPlacement(profileDir) {
  try {
    const prefPath = path.join(profileDir, 'Default', 'Preferences')
    if (!fs.existsSync(prefPath)) return
    const raw = fs.readFileSync(prefPath, 'utf8')
    const prefs = JSON.parse(raw)
    if (prefs.browser) {
      delete prefs.browser.window_placement
      delete prefs.browser.window_placement_popup
      if (prefs.browser.window_placement_app) delete prefs.browser.window_placement_app
    }
    fs.writeFileSync(prefPath, JSON.stringify(prefs), 'utf8')
  } catch {
    // 忽略：文件损坏或锁定时跳过，下次启动会重建
  }
}

function openInBrowser(url) {
  if (process.env.DSH_GATE_NO_OPEN) return
  // 已经在关停了就别再开窗——否则刚开的窗口马上变成没人管的空白 --app 窗口
  if (shuttingDown) return
  try {
    if (process.platform === 'win32') {
      for (const bin of appBrowserCandidates()) {
        if (fs.existsSync(bin)) {
          const { w, h } = panelWindowSize()
          const profileDir = panelProfileDir()
          fs.mkdirSync(profileDir, { recursive: true })
          clearSavedWindowPlacement(profileDir)
          const child = spawn(bin, [
            `--user-data-dir=${profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            // 面板 profile 是隔离的一次性目录，但 Edge 会顺着 Windows 账户 SSO 自动登录，
            // 然后在 --app 窗口上挂一个「我们正在你的所有设备上同步你的浏览数据」通知弹窗
            // （524×364、无标题、被 app 窗口 owned）。它不进任务栏、随浏览器一起消失，
            // 看上去就是个「暗色、没内容、没按钮」的不明窗口（截图里文字还被截断）。
            // --disable-sync + --no-service-autorun 实测能彻底压掉它。
            '--disable-sync',
            '--no-service-autorun',
            '--app=' + url,
            `--window-size=${w},${h}`
            // 注意：**绝不能加 windowsHide: true**。那是给控制台程序的，对 GUI 的 Edge 等于
            // 让首个窗口以 SW_HIDE 启动——实测 --app 主窗口会一直是 vis=false 永不显示，
            // 只剩上面那个通知弹窗可见，正好就是「只有一个暗色空窗口」的观感。
          ], { detached: true, stdio: 'ignore' })
          // spawn 失败是异步 'error' 事件，没有监听器会抛 uncaughtException 炸掉整个启动器
          child.on('error', (err) => say('start', `应用窗口拉起失败（${err.message}）；手动打开面板地址`))
          child.unref()
          // 记录浏览器主进程 pid：关窗时 killPanelBrowser 优先按它杀（不依赖 WMI，本机
          // 实测 WMI 会整片报错、按命令行扫会静默失效）。若 1.5s 后这个进程已经不在了，
          // 说明 Edge 把命令交给了同 profile 的既有实例（窗口属于那个进程），这时**不要**
          // 覆盖记录——保留上一轮那个仍然有效的 pid 才是对的。
          setTimeout(() => {
            if (!alive(child)) return
            state.panelBrowserPid = child.pid
            try { fs.writeFileSync(panelPidFile(profileDir), String(child.pid), { mode: 0o600 }) } catch { }
          }, 1500).unref()
          startWatchdog()
          say('start', `已打开控制面板（${path.basename(bin)}，${w}×${h}）`)
          return
        }
      }
      const cmd = spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true })
      cmd.on('error', (err) => say('start', `打开默认浏览器失败（${err.message}）；手动打开面板地址`))
      cmd.unref()
      say('start', '已用默认浏览器打开控制面板')
      return
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const op = spawn(opener, [url], { detached: true, stdio: 'ignore' })
    op.on('error', (err) => say('start', `打开默认浏览器失败（${err.message}）；手动打开面板地址`))
    op.unref()
    say('start', '已用默认浏览器打开控制面板')
  } catch {
    say('start', '打开浏览器失败；手动复制面板地址')
  }
}

// 面板看门狗：本进程意外死亡（控制台被 X / 崩溃 / 被杀）时，由它发现后关闭面板
// 应用窗口——CTRL_CLOSE_EVENT 下 Node 收不到信号，自己没机会清理（约束 6 同源）。
// 正常关停走 shutdown() 里的 killPanelBrowser，看门狗只管意外死亡。
function startWatchdog() {
  if (state.watchdog && alive(state.watchdog)) return
  try {
    const p = spawn(process.execPath, [path.join(__dirname, 'watchdog.mjs'), String(process.pid), panelProfileDir()], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    p.on('error', () => { state.watchdog = null }) // 异步 spawn 失败：看门狗是增强不是必需
    p.unref()
    state.watchdog = p
  } catch { /* 看门狗是增强不是必需，失败不影响主流程 */ }
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

  // 控制台窗口标题：start.bat 用 `start "dsh-remote-gate" /min powershell ...` 指定过标题，
  // 但 PowerShell 启动时会把控制台标题改成「Windows PowerShell」，于是任务栏里那个最小化的
  // 窗口完全认不出是谁——用户会以为「莫名多了一个窗口」。node 与 PowerShell 共用一个控制台，
  // 这里设 process.title 等价于 SetConsoleTitle，直接把窗口改名（实测有效）。
  // 只放在 main 里：测试会 import 本模块，不能在别人的控制台上乱改标题。
  process.title = 'dsh-remote-gate'

  // 1) 配置：老安装的 frpc.toml 参数迁入 config.json；确保令牌存在（面板登录要用）
  let cfg = loadConfig()
  const mig = migrateFrpIntoConfig(cfg)
  if (mig.migrated) {
    cfg = mig.cfg
    saveConfigAtomic(cfg)
    say('start', '已将 frp/frpc.toml 迁入 config.json（frpc.toml 此后是生成产物）')
  }
  cfg = ensureToken(cfg).cfg
  state.cfg = cfg

  // 2) 让产物跟上数据源：config.json 改了 frp 的地址/端口/令牌，frpc.toml 必须同步重生成。
  // 只在面板保存时生成是不够的——手改 config.json 后 frpc 仍读旧值，连不上又团灭，
  // 面板根本来不及打开，用户就锁死在「改了没生效、面板进不去」里（换服务器踩过）。
  try {
    if (syncFrpcToml(cfg)) say('start', '已按 config.json 重生成 frp/frpc.toml')
  } catch (err) {
    sayErr('start', `frpc.toml 重生成失败: ${err && err.message ? err.message : err}（沿用现有文件）`)
  }

  // 3) 启动 dsh web（已在运行则跳过，且外部 dsh 不归面板重启按钮管）
  const dshWasRunning = await probeDsh()
  // 上一轮留下的启动令牌对新 dsh 进程一定无效，先清掉，免得网关把浏览器送到一个废令牌上
  dropDshLaunchToken()
  if (dshWasRunning) {
    state.dsh.external = true
    say('start', 'dsh web 已在 3080 运行，跳过启动')
    say('start', '外部 dsh 无启动令牌，远端登录会 401；用本启动器拉起 dsh，或设 DSH_GATE_DSH_TOKEN')
  } else {
    say('start', '启动 dsh web…')
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
    say('start', '尚未配置访问模式；在面板填写并保存后自动拉起网关与隧道')
  } else {
    const pre = preflightForMode(normalizeMode(cfg.mode) || 'frp')
    if (!pre.ok) {
      sayErr('start', pre.hint)
      sayErr('start', '网关与隧道未启动；修复后重新保存配置')
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
      // 先给网关一点时间暴露「端口被占」这类秒失败，再决定是否开窗。否则会先弹出一个
      // 面板窗口、紧接着整个栈团灭，留下一个指向死服务的 --app 窗口——没有工具栏、
      // 只有背景色、标题退化成主机名，用户完全认不出是什么，也关不掉（踩过）。
      // 1.2s 足够让子进程 EADDRINUSE 的 exit 回调先跑到 shutdown()。
      await new Promise((r) => setTimeout(r, 1200))
      if (shuttingDown) {
        sayErr('start', '启动未完成，未打开面板窗口')
      } else {
        openInBrowser(state.panel.url)
      }
      // 面板窗口被误关时，回控制台按回车重新打开（start.bat 启动的控制台最小化在任务栏）
      if (process.stdin.isTTY) {
        say('start', '按回车重开面板窗口')
        process.stdin.on('data', (d) => {
          if (/\r|\n/.test(String(d)) && state.panel) openInBrowser(state.panel.url)
        })
      }
    } catch (err) {
      sayErr('start', `面板启动失败: ${err.message}（转为纯命令行）`)
    }
  }
}

// 主入口判定必须容忍路径差异：Node 默认对主模块做 realpath（--preserve-symlinks-main 才关）。
// 经目录联接点/软链进入仓库时（另一台设备踩过），argv[1] 是链接路径、import.meta.url 是
// 真实路径，严格相等会把 main() 静默跳过——进程零输出、exit 0 秒退，连 start-crash.log 都没机会写。
// Windows 文件系统大小写不敏感，比较时统一小写兜底。
export function samePath(a, b) {
  if (a === b) return true
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s)
  if (fold(a) === fold(b)) return true
  try { return fold(fs.realpathSync.native(a)) === fold(fs.realpathSync.native(b)) } catch { return false }
}

const isMain = process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))
if (isMain) {
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.on('uncaughtException', (err) => fatalCrash(err, 'uncaughtException'))
  process.on('unhandledRejection', (err) => fatalCrash(err, 'unhandledRejection'))
  // 首行横幅：窗口连这行都没有 = node 根本没起来（PATH/权限/杀软），与脚本内崩溃区分开
  say('start', `node ${process.version} / ${process.platform} ${process.arch}`)
  main().catch((err) => fatalCrash(err, 'main'))
}

export { shouldIgnoreLine, FRPC_IGNORE, CF_IGNORE, CF_IGNORE_RE, extractCfUrl, waitExit, extractDshLaunchToken }
