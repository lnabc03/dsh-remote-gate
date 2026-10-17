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
import fs from 'node:fs'
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

// 面板浏览器主进程的 pid 记录文件，与 panel-profile 同级（不放 profile 里，那是 Chromium 的地盘）。
// 由 start.mjs 在拉起面板窗口后写入；killPanelBrowser 优先读它。
export function panelPidFile(profileDir) {
  return path.join(path.dirname(profileDir), 'panel-browser.pid')
}

// 关闭「面板专用 profile」的浏览器窗口。
//
// 两条通道，缺一不可：
//  1) 按记录的 pid 直接 process.kill（不依赖任何外部工具）。
//  2) 按命令行里带 profile 路径精确匹配（WMI 正常时最精确，也能收拾别的会话留下的）。
//
// 为什么必须有第 1 条：第 2 条靠 `Get-CimInstance Win32_Process`，而本机实测 WMI 会整片报错
// （HRESULT 0x80004005，连试 8 次全失败）。原先只有第 2 条，查询一抛错就被 catch 吞掉，
// $procs 为空 → 什么都不杀、也不报错，面板窗口就永久残留。pid 通道不碰 WMI，稳。
export async function killPanelBrowser(profileDir, excludePid = 0) {
  if (!profileDir) return
  if (process.platform === 'win32') {
    // 1) 按 pid：先礼貌关窗（CloseMainWindow 只要 pid，同样不走 WMI），宽限后强杀兜底。
    //    强杀 Edge 会让它下次启动弹「未正常关闭，恢复页面？」——礼貌关能避免。
    try {
      const pid = Number(fs.readFileSync(panelPidFile(profileDir), 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== excludePid) {
        await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p.MainWindowHandle -ne 0) { $p.CloseMainWindow() | Out-Null } } catch { }`])
        await sleep(CLOSE_GRACE_MS)
        try { process.kill(pid) } catch { /* 已经退了 */ }
      }
    } catch { /* 没有记录文件 */ }

    // 2) 按命令行扫（WMI）。查不到就立刻返回，不白等宽限期——WMI 坏掉时
    //    这条会整片报错，不能让每次关停都搭上一个空转的 1.5s。
    const dir = String(profileDir).replace(/'/g, "''")
    const script = [
      `$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') -and $_.ProcessId -ne $PID -and $_.ProcessId -ne ${excludePid | 0} }`,
      `if (-not $procs) { return }`,
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
