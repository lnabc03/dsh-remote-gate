// config-lib.mjs — config.json 唯一数据源的读写、校验、迁移与 frpc.toml 生成
// 供 start.mjs（启动/面板保存）与 admin.mjs（面板 API）共用；全部纯 Node 内置模块。
//
// 数据源纪律：frp 的 serverAddr/serverPort/authToken 也存 config.json 的 frp 字段，
// frp/frpc.toml 只是保存/启动时由 config.json 全量重生成的产物（勿手动编辑，勿回退为数据源）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  readConfigJson,
  readFrpcConfig,
  renderFrpcToml,
  validateServer,
  validatePort,
  validateToken,
  normalizeDomain,
  validateDomain,
  normalizeMode,
  validateMode,
  validateSshUser,
  validateSshKeyPath,
  defaultSshKeyPath,
  frpcBinaryName,
  cloudflaredBinaryName,
} from './setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = __dirname
export const CONFIG_PATH = path.join(ROOT, 'config.json')
export const FRPC_PATH = path.join(ROOT, 'frp', 'frpc.toml')

export const FRP_RELEASES = 'https://github.com/fatedier/frp/releases'
export const CLOUDFLARED_RELEASES = 'https://github.com/cloudflare/cloudflared/releases'

// ---- 读写 ----------------------------------------------------------------------

export function loadConfig(configPath = CONFIG_PATH) {
  try {
    return readConfigJson(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

// 原子写入：先写临时文件再 rename，防止写到一半断电/被杀留下半个 JSON（网关下次起不来）
export function saveConfigAtomic(cfg, configPath = CONFIG_PATH) {
  const tmp = configPath + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, configPath)
}

// 确保有网关令牌：没有则生成并落盘（原来由 gateway.mjs 首启时生成；面板启动更早，需要一个确定令牌）
export function ensureToken(cfg, configPath = CONFIG_PATH) {
  if (typeof cfg.token === 'string' && cfg.token.length > 0) return { cfg, generated: false }
  const next = { ...cfg, token: newToken() }
  saveConfigAtomic(next, configPath)
  return { cfg: next, generated: true }
}

export function newToken() {
  return crypto.randomBytes(24).toString('base64url')
}

// ---- 迁移：老安装的 frp 参数在 frpc.toml 里 → 搬进 config.json.frp -------------------
// 返回 { cfg, migrated }；调用方负责在 migrated 时 saveConfigAtomic。
export function migrateFrpIntoConfig(cfg, frpcPath = FRPC_PATH) {
  if (cfg.frp && cfg.frp.serverAddr) return { cfg, migrated: false }
  let disk = {}
  try {
    disk = readFrpcConfig(fs.readFileSync(frpcPath, 'utf8'))
  } catch {
    return { cfg, migrated: false }
  }
  if (!disk.serverAddr) return { cfg, migrated: false }
  const frp = {
    serverAddr: disk.serverAddr,
    serverPort: disk.serverPort ?? 7000,
    authToken: disk.authToken ?? '',
  }
  return { cfg: { ...cfg, frp }, migrated: true }
}

// ---- 面板表单校验 ------------------------------------------------------------------
// payload: { mode, domain?, ssh?: {host,port,user,keyPath}, frp?: {serverAddr,serverPort,authToken}, token? }
// 返回 { errors: {字段: 消息} } 或 { errors: null, config }；config 已合并 existing 的无关字段
//（其他模式的子配置保留不删，便于切回；port/targetPort 等隐藏字段也保留）。
export function validatePanelConfig(payload, existing = {}) {
  const errors = {}
  const mode = normalizeMode(payload?.mode)
  const modeErr = validateMode(mode)
  if (modeErr) errors.mode = modeErr

  const config = { ...existing, mode }
  const text = (v) => String(v ?? '').trim()
  // 表单空串 = 未改动 → 回退 existing 的值（?? 只挡 undefined，挡不住 ''）
  const pick = (v, fallback) => {
    const s = text(v)
    return s !== '' ? s : (fallback ?? '')
  }

  // 域名：frp/ssh 必填；lan/cf 保留原值（不强制）
  const domain = normalizeDomain(payload?.domain ?? existing.domain ?? '')
  if (mode === 'frp' || mode === 'ssh') {
    const err = validateDomain(domain)
    if (err) errors.domain = err
  }
  if (domain) config.domain = domain
  else if (mode === 'frp' || mode === 'ssh') delete config.domain

  if (mode === 'frp') {
    const frpIn = payload?.frp ?? {}
    const frp = {
      serverAddr: pick(frpIn.serverAddr, existing.frp?.serverAddr),
      serverPort: text(frpIn.serverPort) === '' ? (existing.frp?.serverPort ?? 7000) : Number(frpIn.serverPort),
      authToken: pick(frpIn.authToken, existing.frp?.authToken),
    }
    const e1 = validateServer(frp.serverAddr)
    if (e1) errors['frp.serverAddr'] = e1
    const e2 = validatePort(frp.serverPort)
    if (e2) errors['frp.serverPort'] = e2
    const e3 = validateToken(frp.authToken)
    if (e3) errors['frp.authToken'] = e3
    config.frp = frp
  }

  if (mode === 'ssh') {
    const sshIn = payload?.ssh ?? {}
    const ssh = {
      host: pick(sshIn.host, existing.ssh?.host),
      port: text(sshIn.port) === '' ? (existing.ssh?.port ?? 22) : Number(sshIn.port),
      user: pick(sshIn.user, existing.ssh?.user),
      keyPath: pick(sshIn.keyPath, existing.ssh?.keyPath ?? defaultSshKeyPath()),
    }
    const e1 = validateServer(ssh.host)
    if (e1) errors['ssh.host'] = e1
    const e2 = validatePort(ssh.port)
    if (e2) errors['ssh.port'] = e2
    const e3 = validateSshUser(ssh.user)
    if (e3) errors['ssh.user'] = e3
    const e4 = validateSshKeyPath(ssh.keyPath)
    if (e4) errors['ssh.keyPath'] = e4
    config.ssh = ssh
  }

  // 令牌：留空表示不改动；给了就换（保存后网关重启生效，面板 Cookie 同步换新）
  if (payload?.token !== undefined && text(payload.token) !== '') {
    const t = text(payload.token)
    if (t.length < 8 || /\s/.test(t)) errors.token = '令牌至少 8 个字符且不能含空白'
    else config.token = t
  }

  if (Object.keys(errors).length > 0) return { errors }
  return { errors: null, config }
}

// 指定模式是否已具备启动条件（决定 start.mjs 是否拉起网关+隧道）
export function isConfigured(cfg) {
  const mode = normalizeMode(cfg?.mode)
  if (validateMode(mode) !== null) return false
  if (mode === 'frp') return !!(cfg.frp && cfg.frp.serverAddr && cfg.frp.authToken)
  if (mode === 'ssh') return !!(cfg.ssh && cfg.ssh.host && cfg.ssh.user)
  return true // lan / cf 记了 mode 即视为已配置
}

// 保存前前置检查：隧道二进制是否就位。返回 { ok, hint? }（hint 供面板直接展示）
export function preflightForMode(mode, root = ROOT) {
  if (mode === 'frp') {
    const name = frpcBinaryName()
    if (!fs.existsSync(path.join(root, 'frp', name))) {
      return { ok: false, hint: `未找到 frp/${name}；请从 ${FRP_RELEASES} 下载对应平台 release，把 ${name} 放进 frp/ 目录` }
    }
  }
  if (mode === 'cf') {
    const name = cloudflaredBinaryName()
    if (!fs.existsSync(path.join(root, 'cf', name))) {
      return { ok: false, hint: `未找到 cf/${name}；请从 ${CLOUDFLARED_RELEASES} 下载（Windows 选 cloudflared-windows-amd64.exe，改名为 ${name} 放进 cf/ 目录）` }
    }
  }
  return { ok: true }
}

// 落盘：config.json 原子写 + frp 模式全量重生成 frpc.toml（产物，非数据源）
export function applyPanelConfig(config, { configPath = CONFIG_PATH, frpcPath = FRPC_PATH } = {}) {
  saveConfigAtomic(config, configPath)
  if (normalizeMode(config.mode) === 'frp' && config.frp) {
    fs.writeFileSync(frpcPath, renderFrpcToml(config.frp), { mode: 0o600 })
  }
}
