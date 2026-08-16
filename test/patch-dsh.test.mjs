// patch-dsh.mjs 纯函数 applyPatch 单测：合成内容上验证三处补丁 + 幂等
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch } from '../patch-dsh.mjs'

// 与打包文件一致的 LF + Tab 缩进，嵌入三个锚点
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
  ].join('\n')
}

test('applyPatch：三处都生效', () => {
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
})

test('applyPatch：幂等（第二次 changed=false 且内容不变）', () => {
  const first = applyPatch(synth())
  const second = applyPatch(first.content)
  assert.equal(second.changed, false)
  assert.equal(second.content, first.content)
})

test('applyPatch：锚点缺失时抛错（不落盘）', () => {
  assert.throws(() => applyPatch('// 无锚点的内容\n'), /patch anchor not found/)
})
