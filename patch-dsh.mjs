// patch-dsh.mjs — 幂等补丁 DSH client-runtime。两组补丁：
//
// A. 修复「提问弹窗被重连刷没」的竞态：
//    SessionRuntime.resync() 在每次重连成功时 this.pending.clear()，与服务端
//    mux-open 对未决问题的重放竞态（重放先到、随后被 resync 清掉）。
//    修法：把「清 pending」从 resync() 挪到断线时（handleDisconnected），让重放能落住；
//          断线时清空可避免「断线期间被解决但无补发帧」的陈旧等待。
//
// B. 修复「断帧修复/重连整页重拉」的流量炸弹（移动端隧道流量的 99% 大头）：
//    repairGap() 与 doOpen() 第二阶段都拉 maxMessages:50 的整尾页再 installWindow 整窗
//    替换；实测长会话一页 4.7MB 原始 / 541KB gz（21233 事件），而断帧缺口通常只有几条
//    事件。修法：新增 repairTailMerge()——拉能覆盖当前窗口尾的最小尾页（1→5→50 条消息
//    逐级放大）并 appendLive 合并进现有窗口（seq 去重丢弃重叠，旧事件本就不可变）；
//    50 条仍够不到旧窗尾才退回整窗替换。doOpen 第二阶段同样改走合并。
//    实测 maxMessages:1 仅 57KB gz，常见缺口场景省 ~10 倍。
//
// 由 start.mjs 在启动前调用；字符串替换严格匹配 LF + Tab 缩进，逐锚点幂等
// （已打的锚点按 marker 跳过，兼容只打过 A 组旧补丁的文件）。

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

// 替换锚点，精确匹配打包文件的 LF 换行 + Tab 缩进。marker 为 rep 中的特征串：
// 已存在于文件则说明该锚点已打过，跳过（逐锚点幂等）。
const PATCHES = [
  {
    // A1) resync() 不再清空 pending（保留 baseSeq/subscribedLastSeq/liveBuffer 上下文）
    marker: '\t\t\t\tthis.baseSeq = 0;\n\t\t\t\tthis.subscribedLastSeq = null;',
    old: '\t\t\t\tthis.baseSeq = 0;\n\t\t\t\tthis.pending.clear();\n\t\t\t\tthis.pendingRev++;\n\t\t\t\tthis.subscribedLastSeq = null;\n\t\t\t\tthis.liveBuffer = [];',
    rep: '\t\t\t\tthis.baseSeq = 0;\n\t\t\t\tthis.subscribedLastSeq = null;\n\t\t\t\tthis.liveBuffer = [];',
  },
  {
    // A2) settle() 之后新增 clearPending() 方法
    marker: 'clearPending() {',
    old: '\t\t\tsettle(wait) {\n\t\t\t\twait.markSettled();\n\t\t\t\tthis.pending.delete(wait.key);\n\t\t\t\tthis.pendingRev++;\n\t\t\t}',
    rep: '\t\t\tsettle(wait) {\n\t\t\t\twait.markSettled();\n\t\t\t\tthis.pending.delete(wait.key);\n\t\t\t\tthis.pendingRev++;\n\t\t\t}\n\t\t\t/** Clear every pending wait at disconnect (resolved-while-disconnected sends no frame). */\n\t\t\tclearPending() {\n\t\t\t\tif (this.pending.size === 0) return;\n\t\t\t\tthis.pending.clear();\n\t\t\t\tthis.pendingRev++;\n\t\t\t\tthis.notifier.markDirty();\n\t\t\t}',
  },
  {
    // A3) handleDisconnected() 里逐个会话清 pending
    marker: 'for (const session of this.sessions.values()) session.clearPending();',
    old: '\t\t\thandleDisconnected() {\n\t\t\t\tif (this.pendingInteractions.size > 0) {\n\t\t\t\t\tthis.pendingInteractions.clear();\n\t\t\t\t\tthis.notifier.markDirty();\n\t\t\t\t}\n\t\t\t\tfor (const [sessionId, buffer] of [...this.pendingBuffers]) {',
    rep: '\t\t\thandleDisconnected() {\n\t\t\t\tif (this.pendingInteractions.size > 0) {\n\t\t\t\t\tthis.pendingInteractions.clear();\n\t\t\t\t\tthis.notifier.markDirty();\n\t\t\t\t}\n\t\t\t\tfor (const session of this.sessions.values()) session.clearPending();\n\t\t\t\tfor (const [sessionId, buffer] of [...this.pendingBuffers]) {',
  },
  {
    // B1) doOpen 第二阶段（开窗期间又来了新事件）：不再整页重拉 + 整窗替换，改走增量合并
    marker: '\t\t\t\t\t\tawait this.repairTailMerge(generation);',
    old: '\t\t\t\t\tif (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {\n\t\t\t\t\t\tresult = (await this.history({ maxMessages: 50 })).result;\n\t\t\t\t\t\tif (generation !== this.openGeneration) return;\n\t\t\t\t\t\tif (result.ok) this.installWindow(result.value.events, result.value.hasMore, result.value.projections);\n\t\t\t\t\t}',
    rep: '\t\t\t\t\tif (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {\n\t\t\t\t\t\tawait this.repairTailMerge(generation);\n\t\t\t\t\t\tif (generation !== this.openGeneration) return;\n\t\t\t\t\t}',
  },
  {
    // B2) repairGap：整页重拉替换 → repairTailMerge 增量合并（新增方法 + 改写调用处）
    marker: 'async repairTailMerge(generation) {',
    old: '\t\t\tasync repairGap() {\n\t\t\t\t/* v8 ignore next -- re-entry guard: acceptLiveEvent already detours to liveBuffer while stitching, so no second call reaches here. */\n\t\t\t\tif (this.stitching) return;\n\t\t\t\tthis.stitching = true;\n\t\t\t\tconst generation = this.openGeneration;\n\t\t\t\ttry {\n\t\t\t\t\tconst { result } = await this.history({ maxMessages: 50 });\n\t\t\t\t\tif (result.ok && generation === this.openGeneration && this.openState === "open") this.installWindow(result.value.events, result.value.hasMore, result.value.projections);\n\t\t\t\t} catch (error) {\n\t\t\t\t\tconsole.error("[web-runtime] gap repair failed:", error);\n\t\t\t\t} finally {\n\t\t\t\t\tthis.stitching = false;\n\t\t\t\t}\n\t\t\t}',
    rep: '\t\t\t/** Incremental tail repair: pull the smallest tail page that still reaches the current\n\t\t\t*  window tail (1 -> 5 -> 50 messages) and merge it via appendLive, instead of replacing\n\t\t\t*  the whole window with a full 50-message page. Window events are immutable once installed\n\t\t\t*  (appendLive dedups overlaps by seq; overlapped entries keep their first-installed view).\n\t\t\t*  Falls back to a full window replace only when even 50 messages cannot reach the old tail. */\n\t\t\tasync repairTailMerge(generation) {\n\t\t\t\tconst oldTail = this.windowTailSeq();\n\t\t\t\tif (oldTail === null) return;\n\t\t\t\tfor (const size of [1, 5, 50]) {\n\t\t\t\t\tconst { result } = await this.history({ maxMessages: size });\n\t\t\t\t\tif (generation !== this.openGeneration || !result.ok) return;\n\t\t\t\t\tconst entries = result.value.events;\n\t\t\t\t\tconst pageBase = entries[0]?.event.seq ?? 0;\n\t\t\t\t\tif (entries.length > 0 && pageBase > oldTail + 1) {\n\t\t\t\t\t\tif (size < 50) continue; // 页底够不到旧窗尾，放大再试\n\t\t\t\t\t\t// 50 条消息仍够不到（断开跨了多个 turn）：整窗替换，退回旧行为\n\t\t\t\t\t\tif (this.openState === "open") this.installWindow(entries, result.value.hasMore, result.value.projections);\n\t\t\t\t\t\treturn;\n\t\t\t\t\t}\n\t\t\t\t\tif (result.value.projections !== void 0) this.projections.seed(result.value.projections);\n\t\t\t\t\tfor (const entry of entries) this.appendLive(entry.event, entry.view);\n\t\t\t\t\tconst buffered = this.liveBuffer;\n\t\t\t\t\tthis.liveBuffer = [];\n\t\t\t\t\tfor (const item of buffered) this.appendLive(item.event, item.view);\n\t\t\t\t\tthis.notifier.markDirty();\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t}\n\t\t\tasync repairGap() {\n\t\t\t\t/* v8 ignore next -- re-entry guard: acceptLiveEvent already detours to liveBuffer while stitching, so no second call reaches here. */\n\t\t\t\tif (this.stitching) return;\n\t\t\t\tthis.stitching = true;\n\t\t\t\tconst generation = this.openGeneration;\n\t\t\t\ttry {\n\t\t\t\t\tawait this.repairTailMerge(generation);\n\t\t\t\t} catch (error) {\n\t\t\t\t\tconsole.error("[web-runtime] gap repair failed:", error);\n\t\t\t\t} finally {\n\t\t\t\t\tthis.stitching = false;\n\t\t\t\t}\n\t\t\t}',
  },
]

/** 纯函数：对打包内容应用补丁。全部锚点已打则返回 changed=false；锚点缺失/重复则抛错（不落盘）。 */
export function applyPatch(content) {
  if (PATCHES.every((p) => content.includes(p.marker))) return { changed: false, content }
  let out = content
  for (const { old, rep, marker } of PATCHES) {
    if (out.includes(marker)) continue // 该锚点已打过（兼容只打过旧组补丁的文件）
    const idx = out.indexOf(old)
    if (idx === -1) throw new Error('patch anchor not found')
    if (out.indexOf(old, idx + 1) !== -1) throw new Error('patch anchor ambiguous')
    out = out.slice(0, idx) + rep + out.slice(idx + old.length)
  }
  return { changed: true, content: out }
}

function resolveGlobalRoot() {
  try {
    // execSync 走 shell，Windows 上能正确解析 npm.cmd；超时防 npm 异常时无限期卡住
    const out = execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()
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
