// dsh-mobile-mini 一键启动：dsh web + 网关 + frpc 隧道，全部收进当前窗口
//
// 策略：
//   - dsh web：启动前先探 3080，已在运行则跳过；崩溃后自动重启（最多 5 次，间隔 3s）
//   - 网关 / frpc：任一退出则整体退出（隧道断了网关不能裸跑）
//   - Ctrl+C 同时终止全部（Windows 下对 npx 派生树用 taskkill /T）

import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DSH_PORT = 3080

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
      for (const line of lines) out.write(`[${tag}] ${line}\n`)
    })
    stream.on('end', () => { if (buf) out.write(`[${tag}] ${buf}\n`) })
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

function startDsh(retriesLeft = 5) {
  const p = spawn('npx @deepseek-ai/dsh web', {
    shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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

async function main() {
  if (await probeDsh()) {
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
  startVital({ tag: 'frpc', cmd: path.join(__dirname, 'frp', 'frpc.exe'), args: ['-c', path.join(__dirname, 'frp', 'frpc.toml')] })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

main()
