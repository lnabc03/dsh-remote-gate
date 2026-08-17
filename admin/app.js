// DSH Gate 控制面板前端：状态灯 / 登录链接+二维码 / 配置表单 / SSE 日志流
// 纯 vanilla JS（零依赖），QR 用 vendor/qrcode.js（qrcode-generator, MIT）

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

const MODE_NAMES = { frp: 'frp', ssh: 'ssh', lan: 'lan', cf: 'cf' }
const MODE_DESCS = {
  frp: '自有服务器中转，稳定（推荐有服务器时使用）',
  ssh: '复用服务器 sshd，免装 frps，断线自动重拨',
  lan: '同一局域网直连，零配置，明文 HTTP',
  cf: 'Cloudflare 临时隧道，零服务器，域名每次随机',
}

// ---- API 封装 ------------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-DG-Admin': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  return res.json().catch(() => ({ ok: false, errors: { _: '响应不是合法 JSON（HTTP ' + res.status + '）' } }))
}

// ---- 状态灯 + 登录链接 + 二维码 -----------------------------------------------------
function setLight(id, state) { // 'on' | 'off' | 'na'
  const el = $(id)
  el.classList.remove('on', 'off', 'na')
  el.classList.add(state)
}

function renderStatus(s) {
  const mode = s.mode || '未配置'
  const badge = $('#modeBadge')
  badge.textContent = s.configured ? `模式: ${mode}` : '未配置'
  badge.classList.toggle('on', !!s.configured)

  setLight('#lightDsh', s.procs.dsh.running ? 'on' : 'off')
  setLight('#lightGate', s.procs.gate.running ? 'on' : 'off')
  const tunnelLight = !s.configured || (s.mode === 'lan') ? 'na' : (s.procs.tunnel.running ? 'on' : 'off')
  setLight('#lightTunnel', tunnelLight)
  $('#lightTunnel').title = '隧道' + (s.procs.tunnel.tag ? `（${s.procs.tunnel.tag}）` : s.mode === 'lan' ? '（lan 无隧道）' : '')

  const hint = $('#loginHint')
  const row = $('#loginRow')
  const canvas = $('#qrCanvas')
  if (s.login) {
    hint.textContent = '手机扫码或点开链接即可登录（链接内含令牌，勿外发）：'
    const a = $('#loginLink')
    a.textContent = s.login
    a.href = s.login
    row.classList.remove('hidden')
    renderQr(s.login)
  } else if (!s.configured) {
    hint.textContent = '尚未配置访问模式，请先在下方完成配置。'
    row.classList.add('hidden')
    canvas.classList.add('hidden')
  } else if (s.cfPending) {
    hint.textContent = 'cloudflared 正在分配临时域名，几秒后自动出现…'
    row.classList.add('hidden')
    canvas.classList.add('hidden')
  } else {
    hint.textContent = '登录链接暂不可用（网关/隧道未运行）。'
    row.classList.add('hidden')
    canvas.classList.add('hidden')
  }
}

function renderQr(text) {
  const canvas = $('#qrCanvas')
  try {
    const qr = qrcode(0, 'M') // 自动选版本，中纠错
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    const scale = Math.max(2, Math.floor(200 / (n + 8)))
    const size = (n + 8) * scale
    canvas.width = size
    canvas.height = size
    canvas.style.width = size + 'px'
    canvas.style.height = size + 'px'
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = '#000'
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale)
      }
    }
    canvas.classList.remove('hidden')
  } catch {
    canvas.classList.add('hidden')
  }
}

// ---- 配置表单 ----------------------------------------------------------------------
let currentConfig = null

function fillForm(cfg) {
  currentConfig = cfg
  const mode = (cfg.mode || '').toLowerCase()
  const radio = $(`input[name="mode"][value="${mode}"]`)
  if (radio) radio.checked = true
  syncModeSections()

  const set = (name, v) => { const el = $(`[name="${name}"]`); if (el) el.value = v ?? '' }
  set('frp.serverAddr', cfg.frp?.serverAddr)
  set('frp.serverPort', cfg.frp?.serverPort ?? '')
  set('frp.authToken', cfg.frp?.authToken)
  set('ssh.host', cfg.ssh?.host)
  set('ssh.port', cfg.ssh?.port ?? '')
  set('ssh.user', cfg.ssh?.user)
  set('ssh.keyPath', cfg.ssh?.keyPath)
  set('domain', cfg.domain)
  set('token', '') // 令牌留空 = 不修改；不回显当前令牌到输入框
}

function selectedMode() {
  return ($('input[name="mode"]:checked') || {}).value || ''
}

function syncModeSections() {
  const mode = selectedMode()
  $('#fsFrp').classList.toggle('hidden', mode !== 'frp')
  $('#fsSsh').classList.toggle('hidden', mode !== 'ssh')
  $('#fsDomain').classList.toggle('hidden', mode !== 'frp' && mode !== 'ssh')
  $('#noteLan').classList.toggle('hidden', mode !== 'lan')
  $('#noteCf').classList.toggle('hidden', mode !== 'cf')
  $('#modeDesc').textContent = MODE_DESCS[mode] || ''
}

function collectPayload() {
  const val = (name) => { const el = $(`[name="${name}"]`); return el ? el.value.trim() : '' }
  const mode = selectedMode()
  const payload = { mode }
  if (mode === 'frp') {
    payload.frp = {
      serverAddr: val('frp.serverAddr'),
      serverPort: val('frp.serverPort'),
      authToken: val('frp.authToken'),
    }
    payload.domain = val('domain')
  } else if (mode === 'ssh') {
    payload.ssh = {
      host: val('ssh.host'),
      port: val('ssh.port'),
      user: val('ssh.user'),
      keyPath: val('ssh.keyPath'),
    }
    payload.domain = val('domain')
  }
  const token = val('token')
  if (token) payload.token = token
  return payload
}

function showErrors(errors) {
  $$('.field-err').forEach((el) => { el.textContent = '' })
  const msgs = []
  for (const [field, msg] of Object.entries(errors || {})) {
    const el = $(`.field-err[data-err="${field}"]`)
    if (el) el.textContent = msg
    else msgs.push(msg) // 无对应框的（如 mode 二进制缺失）汇总到保存按钮旁
  }
  return msgs
}

async function saveConfig(ev) {
  ev.preventDefault()
  const btn = $('#saveBtn')
  const msg = $('#saveMsg')
  msg.className = 'save-msg'
  msg.textContent = ''
  btn.disabled = true
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify(collectPayload()) })
    if (r.ok) {
      msg.classList.add('ok')
      msg.textContent = r.newToken ? '已保存并重启；令牌已轮换，旧登录态全部失效' : '已保存，网关与隧道重启中…'
      const tokenEl = $('[name="token"]')
      if (tokenEl) tokenEl.value = ''
      setTimeout(refreshAll, 1200)
    } else {
      const extra = showErrors(r.errors)
      msg.classList.add('err')
      msg.textContent = extra.length ? extra.join('；') : '保存失败，请检查标红字段'
    }
  } catch (err) {
    msg.classList.add('err')
    msg.textContent = '请求失败：' + err.message
  } finally {
    btn.disabled = false
  }
}

// 令牌轮换：本机安全上下文（127.0.0.1），crypto.getRandomValues 可用；生成后随表单一起提交
function rotateToken() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  $('[name="token"]').value = b64
  $('#saveMsg').className = 'save-msg'
  $('#saveMsg').textContent = '已生成新令牌，点「保存并重启」后生效'
}

// ---- 操作按钮 ----------------------------------------------------------------------
// 内联二次确认：首次点击按钮变红进入 armed 态，3s 内再点才执行；超时自动恢复
let restartArmTimer = null
async function restartDsh() {
  const btn = $('#restartDshBtn')
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed')
    btn.textContent = '确认重启 dsh？'
    clearTimeout(restartArmTimer)
    restartArmTimer = setTimeout(() => {
      btn.classList.remove('armed')
      btn.textContent = '重启 dsh'
    }, 3000)
    return
  }
  clearTimeout(restartArmTimer)
  btn.classList.remove('armed')
  btn.textContent = '重启 dsh'
  const r = await api('/api/restart-dsh', { method: 'POST', body: '{}' })
  if (!r.ok) alert(r.error || '重启失败')
}

// ---- 日志（SSE） --------------------------------------------------------------------
const LOG_MAX_LINES = 500
let logCount = 0

function appendLog(entry) {
  const pane = $('#logPane')
  const line = document.createElement('span')
  const tag = ('[' + (entry.tag || '?') + ']').padEnd(8)
  line.innerHTML = ''
  const tagSpan = document.createElement('span')
  tagSpan.className = 't-' + (entry.tag || '')
  tagSpan.textContent = tag
  line.appendChild(tagSpan)
  line.appendChild(document.createTextNode(entry.line + '\n'))
  pane.appendChild(line)
  logCount++
  while (logCount > LOG_MAX_LINES && pane.firstChild) { pane.removeChild(pane.firstChild); logCount-- }
  // 跟随滚动：只在用户没往上翻时自动滚到底
  if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80) pane.scrollTop = pane.scrollHeight
}

function connectLogs() {
  const es = new EventSource('/api/logs')
  es.addEventListener('log', (ev) => {
    try { appendLog(JSON.parse(ev.data)) } catch { }
  })
  es.addEventListener('status', (ev) => {
    try { renderStatus(JSON.parse(ev.data)) } catch { }
  })
  es.onerror = () => {
    // EventSource 自动重连；状态轮询兜底
  }
}

// ---- 引导 ---------------------------------------------------------------------------
async function refreshAll() {
  try {
    const [status, cfg] = await Promise.all([
      fetch('/api/status').then((r) => r.json()),
      fetch('/api/config').then((r) => r.json()),
    ])
    renderStatus(status)
    fillForm(cfg)
  } catch { }
}

function boot() {
  $('#configForm').addEventListener('submit', saveConfig)
  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', syncModeSections))
  $('#rotateBtn').addEventListener('click', rotateToken)
  $('#restartDshBtn').addEventListener('click', restartDsh)
  $('#openDshBtn').addEventListener('click', () => window.open('http://127.0.0.1:3080', '_blank', 'noopener'))
  $('#copyBtn').addEventListener('click', async () => {
    const text = $('#loginLink').textContent
    try {
      await navigator.clipboard.writeText(text)
      $('#copyBtn').textContent = '已复制'
      setTimeout(() => { $('#copyBtn').textContent = '复制' }, 1500)
    } catch {
      window.prompt('复制失败，请手动复制：', text)
    }
  })
  refreshAll()
  connectLogs()
  setInterval(() => {
    fetch('/api/status').then((r) => r.json()).then(renderStatus).catch(() => { })
  }, 5000)
}

boot()
