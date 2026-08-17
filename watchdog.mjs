// watchdog.mjs — 面板看门狗：由 start.mjs 以 detached（无控制台）方式拉起。
//
// 用法: node watchdog.mjs <parentPid> <panelProfileDir> [pollMs]
//
// 为什么需要它：Windows 点 X 关控制台发的是 CTRL_CLOSE_EVENT，Node 收不到
// SIGINT/SIGTERM，start.mjs 没有任何机会跑清理（与 AGENTS.md 约束 6 同源）。
// 控制台一死，面板 --app 窗口会静默挂着（SSE 断开、按钮全失效，用户无从得知）。
// 本进程脱离控制台存活，轮询父进程：父死 → 按命令行中的面板专用 profile 路径
// 精确匹配并关闭面板浏览器进程树，随后自杀。正常关停（Ctrl+C / 团灭）由
// start.mjs 自己调用 killPanelBrowser()，看门狗只是意外死亡的兜底。

import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLOSE_GRACE_MS = 1500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function execFileP(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }))
    } catch {
      resolve({ err: true, stdout: '' })
    }
  })
}

// 关闭「命令行里带面板专用 profile 路径」的浏览器进程树。
// 匹配串（LOCALAPPDATA\dsh-remote-gate\panel-profile）只命中面板 --app 窗口的
// 专用 profile（主进程 + renderer/gpu 子进程的命令行都带它），不会误伤用户主浏览器；
// 默认浏览器标签页模式的进程命令行不含此路径，天然不受影响。
// 先 CloseMainWindow 温和关窗，宽限后强杀兜底。excludePid 排除调用者自身
// （看门狗的命令行同样含 profile 路径，不排除会先把自己杀了）。
export async function killPanelBrowser(profileDir, excludePid = 0) {
  if (!profileDir) return
  if (process.platform === 'win32') {
    const dir = String(profileDir).replace(/'/g, "''")
    const script = [
      `$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') -and $_.ProcessId -ne $PID -and $_.ProcessId -ne ${excludePid | 0} }`,
      `foreach ($p in $procs) { try { (Get-Process -Id $p.ProcessId -ErrorAction Stop).CloseMainWindow() | Out-Null } catch { } }`,
      `Start-Sleep -Milliseconds ${CLOSE_GRACE_MS}`,
      `foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }`,
    ].join('; ')
    await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    return
  }
  // POSIX：pgrep -f 匹配命令行（pgrep 不含自身），排除调用者；先 TERM 后 KILL
  const { stdout } = await execFileP('pgrep', ['-f', profileDir])
  const pids = stdout.split(/\s+/).map(Number).filter((n) => n > 0 && n !== process.pid && n !== excludePid)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { } }
  if (!pids.length) return
  await sleep(CLOSE_GRACE_MS)
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { } }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [pidRaw, profileDir, pollRaw] = process.argv.slice(2)
  const parentPid = Number(pidRaw)
  const pollMs = Math.max(200, Number(pollRaw) || 2000)
  if (!parentPid || !profileDir) process.exit(1)
  const parentAlive = () => {
    try { process.kill(parentPid, 0); return true } catch { return false }
  }
  const timer = setInterval(async () => {
    if (parentAlive()) return
    clearInterval(timer)
    try { await killPanelBrowser(profileDir, process.pid) } catch { }
    process.exit(0)
  }, pollMs)
}
