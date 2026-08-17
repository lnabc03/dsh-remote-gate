// watchdog.mjs 端到端测试：父进程死亡 → 看门狗关闭「命令行含面板 profile 路径」的进程并自杀。
// victim 用一个 argv 里带假 profile 路径的 node 进程模拟面板浏览器（其 CommandLine 含路径，
// 与真实 chrome --user-data-dir=<profile> 的匹配原理一致）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WATCHDOG = path.join(__dirname, '..', 'watchdog.mjs')

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 长跑占位进程；extraArgs 会进命令行（供看门狗按 profile 路径匹配）
function spawnLong(...extraArgs) {
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', ...extraArgs], { stdio: 'ignore', windowsHide: true })
}

function spawnWatchdog(parentPid, profileDir, pollMs = 300) {
  const wd = spawn(process.execPath, [WATCHDOG, String(parentPid), profileDir, String(pollMs)], {
    detached: true, stdio: 'ignore', windowsHide: true,
  })
  wd.unref()
  return wd
}

function waitExit(p, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve(true)
    const t = setTimeout(() => resolve(false), timeoutMs)
    p.once('exit', () => { clearTimeout(t); resolve(true) })
  })
}

test('父进程死亡 → 看门狗关闭匹配 profile 的进程并自杀', async (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-wd-'))
  const parent = spawnLong()
  const victim = spawnLong(profileDir)
  const bystander = spawnLong() // 命令行不含 profile 路径，绝不应被误杀
  const wd = spawnWatchdog(parent.pid, profileDir)
  t.after(() => {
    for (const p of [parent, victim, bystander]) { try { p.kill('SIGKILL') } catch { } }
    try { process.kill(wd.pid, 'SIGKILL') } catch { }
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  await sleep(600)
  assert.ok(alive(wd.pid), '看门狗应在运行')

  parent.kill('SIGTERM')
  assert.ok(await waitExit(wd), '看门狗应在父死后自行退出')

  // 温和关窗有 1.5s 宽限，轮询等待 victim 真正消失
  for (let i = 0; i < 40 && alive(victim.pid); i++) await sleep(250)
  assert.ok(!alive(victim.pid), 'victim（模拟面板浏览器）应被看门狗关闭')
  assert.ok(alive(bystander.pid), '命令行不含 profile 路径的进程不得被误杀')
})

test('父进程存活 → 看门狗不动任何进程', async (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-wd-'))
  const parent = spawnLong()
  const victim = spawnLong(profileDir)
  const wd = spawnWatchdog(parent.pid, profileDir)
  t.after(() => {
    for (const p of [parent, victim]) { try { p.kill('SIGKILL') } catch { } }
    try { process.kill(wd.pid, 'SIGKILL') } catch { }
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  await sleep(2500) // 覆盖多个轮询周期
  assert.ok(alive(parent.pid) && alive(victim.pid) && alive(wd.pid), '父存活期间一切照旧')

  // 收尾：杀父后看门狗应退出（同时会顺带关掉 victim，属预期行为）
  parent.kill('SIGTERM')
  assert.ok(await waitExit(wd), '看门狗应在父死后退出')
})
