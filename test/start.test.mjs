// start.mjs 导出的日志过滤纯函数单测（导入安全：main 由 isMain 守卫）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldIgnoreLine, FRPC_IGNORE } from '../start.mjs'

test('shouldIgnoreLine：frpc 的 pool-full 告警被过滤', () => {
  const noisy = '2026-08-17 00:38:19 [E] [client/control.go:153] StartWorkConn contains error: work connection pool is full, discarding'
  assert.equal(shouldIgnoreLine('frpc', noisy), true)
})

test('shouldIgnoreLine：非目标行保留', () => {
  assert.equal(shouldIgnoreLine('frpc', '2026-08-17 00:38:19 [I] frpc 启动成功'), false)
})

test('shouldIgnoreLine：只作用于 frpc tag，不影响 dsh/gate', () => {
  const noisy = 'work connection pool is full'
  assert.equal(shouldIgnoreLine('dsh', noisy), false)
  assert.equal(shouldIgnoreLine('gate', noisy), false)
})

test('FRPC_IGNORE 非空且为字符串数组', () => {
  assert.ok(Array.isArray(FRPC_IGNORE))
  assert.ok(FRPC_IGNORE.length > 0)
  assert.ok(FRPC_IGNORE.every((n) => typeof n === 'string'))
})
