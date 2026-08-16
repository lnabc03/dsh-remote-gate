// patch-dsh.mjs — 幂等补丁 DSH client-runtime，修复「提问弹窗被重连刷没」的竞态。
//
// 根因：SessionRuntime.resync() 在每次重连成功时 this.pending.clear()，与服务端
// mux-open 对未决问题的重放竞态（重放先到、随后被 resync 清掉）。
// 修法：把「清 pending」从 resync() 挪到断线时（handleDisconnected），让重放能落住；
//       断线时清空可避免「断线期间被解决但无补发帧」的陈旧等待。
// 由 start.mjs 在启动前调用；字符串替换严格匹配 LF + Tab 缩进，幂等（已打则跳过）。

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

// 三个替换锚点，精确匹配打包文件的 LF 换行 + Tab 缩进。
const PATCHES = [
  {
    // 1) resync() 不再清空 pending（保留 baseSeq/subscribedLastSeq/liveBuffer 上下文）
    old: '\t\t\t\tthis.baseSeq = 0;\n\t\t\t\tthis.pending.clear();\n\t\t\t\tthis.pendingRev++;\n\t\t\t\tthis.subscribedLastSeq = null;\n\t\t\t\tthis.liveBuffer = [];',
    rep: '\t\t\t\tthis.baseSeq = 0;\n\t\t\t\tthis.subscribedLastSeq = null;\n\t\t\t\tthis.liveBuffer = [];',
  },
  {
    // 2) settle() 之后新增 clearPending() 方法
    old: '\t\t\tsettle(wait) {\n\t\t\t\twait.markSettled();\n\t\t\t\tthis.pending.delete(wait.key);\n\t\t\t\tthis.pendingRev++;\n\t\t\t}',
    rep: '\t\t\tsettle(wait) {\n\t\t\t\twait.markSettled();\n\t\t\t\tthis.pending.delete(wait.key);\n\t\t\t\tthis.pendingRev++;\n\t\t\t}\n\t\t\t/** Clear every pending wait at disconnect (resolved-while-disconnected sends no frame). */\n\t\t\tclearPending() {\n\t\t\t\tif (this.pending.size === 0) return;\n\t\t\t\tthis.pending.clear();\n\t\t\t\tthis.pendingRev++;\n\t\t\t\tthis.notifier.markDirty();\n\t\t\t}',
  },
  {
    // 3) handleDisconnected() 里逐个会话清 pending
    old: '\t\t\thandleDisconnected() {\n\t\t\t\tif (this.pendingInteractions.size > 0) {\n\t\t\t\t\tthis.pendingInteractions.clear();\n\t\t\t\t\tthis.notifier.markDirty();\n\t\t\t\t}\n\t\t\t\tfor (const [sessionId, buffer] of [...this.pendingBuffers]) {',
    rep: '\t\t\thandleDisconnected() {\n\t\t\t\tif (this.pendingInteractions.size > 0) {\n\t\t\t\t\tthis.pendingInteractions.clear();\n\t\t\t\t\tthis.notifier.markDirty();\n\t\t\t\t}\n\t\t\t\tfor (const session of this.sessions.values()) session.clearPending();\n\t\t\t\tfor (const [sessionId, buffer] of [...this.pendingBuffers]) {',
  },
]

/** 纯函数：对打包内容应用补丁。已打则返回 changed=false；锚点缺失/重复则抛错（不落盘）。 */
export function applyPatch(content) {
  if (content.includes('clearPending() {')) return { changed: false, content }
  let out = content
  for (const { old, rep } of PATCHES) {
    const idx = out.indexOf(old)
    if (idx === -1) throw new Error('patch anchor not found')
    if (out.indexOf(old, idx + 1) !== -1) throw new Error('patch anchor ambiguous')
    out = out.slice(0, idx) + rep + out.slice(idx + old.length)
  }
  return { changed: true, content: out }
}

function resolveGlobalRoot() {
  try {
    // execSync 走 shell，Windows 上能正确解析 npm.cmd
    const out = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim()
    if (out) return out
  } catch { /* fall through to convention */ }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'npm', 'node_modules')
  }
  return null
}

function locateClientJs() {
  const candidates = []
  if (process.env.DSH_CLIENT_RUNTIME) candidates.push(process.env.DSH_CLIENT_RUNTIME)
  const root = resolveGlobalRoot()
  if (root) {
    candidates.push(
      path.join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js'),
      path.join(root, '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js'),
    )
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

/**
 * 定位并补丁 DSH client-runtime。
 * @returns {{ status: 'patched'|'already'|'missing'|'error', path?: string, message?: string }}
 */
export function patchDsh() {
  const file = locateClientJs()
  if (file === null) return { status: 'missing' }
  try {
    const original = fs.readFileSync(file, 'utf8')
    const { changed, content } = applyPatch(original)
    if (!changed) return { status: 'already', path: file }
    fs.writeFileSync(file, content)
    return { status: 'patched', path: file }
  } catch (error) {
    return { status: 'error', path: file, message: error instanceof Error ? error.message : String(error) }
  }
}

export { PATCHES }
