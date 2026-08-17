// patch-dsh.mjs 纯函数 applyPatch 单测：合成内容上验证五处补丁 + 逐锚点幂等
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch } from '../patch-dsh.mjs'

// 与打包文件一致的 LF + Tab 缩进，嵌入全部锚点
function synth() {
  return [
    '\t\t\tsettle(wait) {',
    '\t\t\t\twait.markSettled();',
    '\t\t\t\tthis.pending.delete(wait.key);',
    '\t\t\t\tthis.pendingRev++;',
    '\t\t\t}',
    '',
    '\t\t\tasync resync() {',
    '\t\t\t\tthis.baseSeq = 0;',
    '\t\t\t\tthis.pending.clear();',
    '\t\t\t\tthis.pendingRev++;',
    '\t\t\t\tthis.subscribedLastSeq = null;',
    '\t\t\t\tthis.liveBuffer = [];',
    '\t\t\t}',
    '',
    '\t\t\thandleDisconnected() {',
    '\t\t\t\tif (this.pendingInteractions.size > 0) {',
    '\t\t\t\t\tthis.pendingInteractions.clear();',
    '\t\t\t\t\tthis.notifier.markDirty();',
    '\t\t\t\t}',
    '\t\t\t\tfor (const [sessionId, buffer] of [...this.pendingBuffers]) {',
    '\t\t\t\t}',
    '\t\t\t}',
    '',
    // B1 锚点：doOpen 第二阶段整页重拉
    '\t\t\t\t\tif (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {',
    '\t\t\t\t\t\tresult = (await this.history({ maxMessages: 50 })).result;',
    '\t\t\t\t\t\tif (generation !== this.openGeneration) return;',
    '\t\t\t\t\t\tif (result.ok) this.installWindow(result.value.events, result.value.hasMore, result.value.projections);',
    '\t\t\t\t\t}',
    '',
    // B2 锚点：repairGap 整页重拉替换
    '\t\t\tasync repairGap() {',
    '\t\t\t\t/* v8 ignore next -- re-entry guard: acceptLiveEvent already detours to liveBuffer while stitching, so no second call reaches here. */',
    '\t\t\t\tif (this.stitching) return;',
    '\t\t\t\tthis.stitching = true;',
    '\t\t\t\tconst generation = this.openGeneration;',
    '\t\t\t\ttry {',
    '\t\t\t\t\tconst { result } = await this.history({ maxMessages: 50 });',
    '\t\t\t\t\tif (result.ok && generation === this.openGeneration && this.openState === "open") this.installWindow(result.value.events, result.value.hasMore, result.value.projections);',
    '\t\t\t\t} catch (error) {',
    '\t\t\t\t\tconsole.error("[web-runtime] gap repair failed:", error);',
    '\t\t\t\t} finally {',
    '\t\t\t\t\tthis.stitching = false;',
    '\t\t\t\t}',
    '\t\t\t}',
  ].join('\n')
}

test('applyPatch：五处都生效', () => {
  const { changed, content } = applyPatch(synth())
  assert.equal(changed, true)
  // 新增 clearPending 方法
  assert.match(content, /clearPending\(\) \{/)
  // resync 里的 pending.clear 被移除（baseSeq 直接接 subscribedLastSeq）
  assert.ok(!content.includes('\t\t\t\tthis.baseSeq = 0;\n\t\t\t\tthis.pending.clear();'))
  assert.match(content, /this\.baseSeq = 0;\n\t\t\t\tthis\.subscribedLastSeq = null;/)
  // handleDisconnected 里逐个会话清 pending
  assert.match(content, /for \(const session of this\.sessions\.values\(\)\) session\.clearPending\(\);/)
  // 原来的 handleDisconnected 逻辑仍在
  assert.match(content, /if \(this\.pendingInteractions\.size > 0\)/)
  // B1：doOpen 第二阶段改走增量合并
  assert.match(content, /await this\.repairTailMerge\(generation\);/)
  assert.ok(!content.includes('result = (await this.history({ maxMessages: 50 })).result;'))
  // B2：新增 repairTailMerge 方法，repairGap 改调它
  assert.match(content, /async repairTailMerge\(generation\) \{/)
  assert.match(content, /for \(const size of \[1, 5, 50\]\)/)
  assert.ok(!content.includes('const { result } = await this.history({ maxMessages: 50 });'))
})

test('applyPatch：幂等（第二次 changed=false 且内容不变）', () => {
  const first = applyPatch(synth())
  const second = applyPatch(first.content)
  assert.equal(second.changed, false)
  assert.equal(second.content, first.content)
})

test('applyPatch：逐锚点幂等——只打过 A 组旧补丁的文件可增量补打 B 组', () => {
  // 构造「A 组已打、B 组未打」的混合状态：先合成全锚点，把 A 组锚点换成已打形态
  const half = synth()
    .replace('\t\t\t\tthis.baseSeq = 0;\n\t\t\t\tthis.pending.clear();\n\t\t\t\tthis.pendingRev++;\n\t\t\t\tthis.subscribedLastSeq = null;',
      '\t\t\t\tthis.baseSeq = 0;\n\t\t\t\tthis.subscribedLastSeq = null;')
    .replace('\t\t\t}',
      '\t\t\t}\n\t\t\tclearPending() {\n\t\t\t\tif (this.pending.size === 0) return;\n\t\t\t}')
    .replace('\t\t\t\tfor (const [sessionId, buffer] of [...this.pendingBuffers]) {',
      '\t\t\t\tfor (const session of this.sessions.values()) session.clearPending();\n\t\t\t\tfor (const [sessionId, buffer] of [...this.pendingBuffers]) {')
  const { changed, content } = applyPatch(half)
  assert.equal(changed, true)
  assert.match(content, /async repairTailMerge\(generation\) \{/)
  // 再次应用 → 全锚点已打，幂等
  assert.equal(applyPatch(content).changed, false)
})

test('applyPatch：锚点缺失时抛错（不落盘）', () => {
  assert.throws(() => applyPatch('// 无锚点的内容\n'), /patch anchor not found/)
})
