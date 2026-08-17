# dsh-remote-gate

> 最小化的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）远程访问网关：手机/平板经公网服务器（frp 或 SSH 反向隧道）、Cloudflare 临时隧道（零服务器）或同一局域网，安全操控本机的 DSH Web UI，可安装为 PWA。

纯 Node ≥ 18，**零 npm 依赖**。只做三件事：**令牌认证 · 反向代理（含 WebSocket）· PWA 注入**。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

## 为什么需要它

1. **DSH 的本机风控**：DSH Web UI 对工作区、设置、凭证等敏感 API 要求请求来自本机，直接用 frp 暴露 3080 会被拦。本网关在本机代理，并抹平一切「非本机访问」痕迹（见[安全模型](#安全模型)）。
2. **移动端可用性**：注入 manifest 与安装 meta，手机「添加到主屏幕」即成为全屏独立 App。

## 快速开始

```bash
git clone <repo> && cd dsh-remote-gate
npm start          # Windows 也可直接双击 start.bat
```

首次启动自动打开**本地控制面板**（Chrome/Edge 应用窗口；`--no-ui` 可关闭）：选模式、填字段、保存——保存即写入 `config.json` 并自动重启网关与隧道（dsh 不动，保护正在运行的 agent 会话）。面板首页展示带令牌的登录链接和**二维码**，手机扫码即登录（种下一年有效的 HttpOnly Cookie，之后直接访问即可）。面板还提供子进程状态灯、实时日志流、令牌管理。

改配置/切模式都在面板完成；`config.json` 是唯一配置数据源（`frp/frpc.toml` 是生成产物，勿手动编辑）。

## 选哪种模式

| 模式 | 需要什么 | 入口地址 | 移动端 PWA | 适合 |
| --- | --- | --- | --- | --- |
| **frp** | 公网服务器 + frps + 域名反代 | 固定域名，HTTPS | ✅ 推荐安装 | 长期主力，最稳 |
| **ssh** | 公网服务器（有 sshd 即可）+ 域名反代 | 固定域名，HTTPS | ✅ 推荐安装 | 已有 SSH 服务器，不想装 frps |
| **lan** | 什么都不用，手机连同一 Wi-Fi | `http://局域网IP:3088`，HTTP 明文 | ⚠️ Android 不可装；iPhone 可 web clip | 家中/办公室临时用 |
| **cf** | 下载 cloudflared，无需服务器/账号/域名 | 每次启动随机临时域名，HTTPS | ❌ 不建议（域名随重启作废） | 零成本快速体验 |

## 初次配置（按模式）

### frp 模式

| 侧 | 步骤 |
| --- | --- |
| 本机 | ① 从 [frp releases](https://github.com/fatedier/frp/releases) 下载 frpc 放进 `frp/`（改名为 `frpc.exe` / `frpc`）② 面板选 frp，填 frps 地址 / 端口（默认 7000）/ token / 域名，保存 |
| 服务器 | ① frps 的 `frps.toml` 加 `transport.maxPoolCount = 20`（与 frpc 对齐，否则刷 `work connection pool is full`）② Nginx/Caddy 把域名 HTTPS 反代到 frps 暴露的 `remotePort`（默认 3088），带 `X-Forwarded-Proto: https` 头，并调大读超时（见下） |
| 移动端 | 扫面板二维码或打开登录链接 → 进入 DSH；HTTPS 下推荐安装为 PWA（见[移动端使用](#移动端使用)） |

### ssh 模式

| 侧 | 步骤 |
| --- | --- |
| 本机 | 无需下载任何二进制（用系统自带 OpenSSH）；面板选 ssh，填服务器地址 / 端口（默认 22）/ 用户名 / 私钥路径（默认 `~/.ssh/id_ed25519`）/ 域名，保存 |
| 服务器 | ① sshd 运行中且 `AllowTcpForwarding yes`（无需 `GatewayPorts`）② 本机公钥加入该账号 `~/.ssh/authorized_keys` ③ 本机先手动 `ssh <用户>@<服务器>` 一次录入主机指纹（`StrictHostKeyChecking=yes`，不录会拒连）④ 反代同 frp，转发到 `127.0.0.1:3088` |
| 移动端 | 同 frp：HTTPS 固定域名，推荐安装 PWA。稳定性略逊于 frp、流式输出略卡，属预期 |

### lan 模式

| 侧 | 步骤 |
| --- | --- |
| 本机 | 面板选 lan 保存即可（无需任何字段）；首次绑 `0.0.0.0` 时 Windows 弹防火墙提示，点「允许」且只勾「专用网络」 |
| 服务器 | 无 |
| 移动端 | 手机连**同一 Wi-Fi**，打开 `http://<局域网IP>:3088/?t=…`（面板有二维码）。明文 HTTP 是已接受的取舍（同网可嗅探令牌，威胁模型 = 可信家庭 Wi-Fi）。打不开多为校园网/企业 Wi-Fi 的 AP 客户端隔离——用「手机开热点、电脑连热点」排除；打印的 IP 按默认路由选取（自动避开虚拟网卡），候选 IP 见启动横幅 |

### cf 模式（Cloudflare quick tunnel）

| 侧 | 步骤 |
| --- | --- |
| 本机 | ① 下载 cloudflared 放进 `cf/`（指引见 [`cf/README.md`](cf/README.md)，面板保存时缺二进制会被拒并提示）② 面板选 cf 保存，无需任何字段/账号 |
| 服务器 | 无 |
| 移动端 | 每次启动数秒后，日志与面板出现新的登录链接（含二维码），重新发到手机。**不建议装 PWA**（临时域名随重启作废，安装产物随之失效）；TLS 在 CF 边缘终止（明文对 CF 可见）；大陆访问 CF 边缘的质量因运营商/时段而异，建议先实测 |

### 服务器反代注意（frp / ssh）

dsh 的 `/api/commands/execute`（如 `/compact`）是同步长任务，响应执行完才返回、期间零字节——Nginx 默认 `proxy_read_timeout 60s` 会 504。**网关已内置缓解**（drip 保活 + 102 心跳，见 [`PITFALLS.md`](PITFALLS.md) §1），默认 60s 也能扛分钟级命令；仍建议双保险（对 WebSocket 长连接同样必要；Caddy 默认无读超时，无需配置）：

```nginx
proxy_read_timeout 600s;
proxy_send_timeout 600s;
```

## 移动端使用

**安装为 PWA**（frp / ssh 的 HTTPS 下）：

- **iOS**：Safari 打开 → 分享 →「添加到主屏幕」
- **Android**：用 Chrome/Edge 打开（厂商自带浏览器大多阉割了 PWA 安装），页面上点几下并停留 30 秒以上（Chrome 的互动启发式硬条件）→ 菜单 →「安装应用」。无 Google Play 服务的 ROM 会退化为普通快捷方式

**推荐配合移动端 UI 插件**：本网关只负责把页面安全送到手机，不改 DSH 的界面。DSH Web UI 为桌面设计，手机上建议安装社区的移动端适配/增强插件：

- [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) — DSH Web 移动端 UI 适配
- [dsh-web-mobile-fix](https://github.com/AcidGr/dsh-web-mobile-fix) — 移动端体验增强修复

按各插件 README 装入 DSH 即可，与本网关互不冲突。

## 配置参考

全部配置在面板完成；以下为等价的环境变量 / `config.json` 字段（高级用法）：

| 来源 | 项 | 默认 | 说明 |
| --- | --- | --- | --- |
| `config.json` | `token` / `port` / `targetPort` / `domain` | — | 访问令牌 / 网关端口 / DSH 端口 / 公网域名（面板写入） |
| `config.json` | `mode` | `frp` | `frp` / `ssh` / `lan` / `cf` |
| `config.json` | `frp.serverAddr` / `.serverPort` / `.authToken` | — | frp 模式专用（唯一数据源） |
| `config.json` | `ssh.host` / `.port` / `.user` / `.keyPath` | — | ssh 模式专用 |
| env | `DSH_GATE_PORT` / `DSH_GATE_BIND` / `DSH_GATE_TARGET_PORT` | `3088` / 按模式 / `3080` | 覆盖对应 config 项；`BIND` 缺省：lan → `0.0.0.0`，其余 → `127.0.0.1` |
| env | `DSH_GATE_TOKEN` / `DSH_GATE_DOMAIN` / `DSH_GATE_CONFIG` | — | 覆盖令牌 / 域名 / 配置文件路径 |
| env | `DSH_GATE_PANEL_PORT` / `DSH_GATE_PANEL_WINSIZE` / `DSH_GATE_NO_OPEN` | `3089` / `1440x860` / — | 面板端口（占用自动递增）/ `--app` 窗口尺寸 / 置 1 不自动打开面板 |
| env | `DSH_GATE_HEARTBEAT_MS` | `25000` | 非 WebKit 客户端的慢路径 102 心跳间隔；0 关闭；WebKit 自动豁免 |
| env | `DSH_GATE_DRIP_GRACE_MS` / `DSH_GATE_DRIP_MS` | `20000` / `25000` | drip（仅 `/api/commands/execute`）宽限期 / 滴包间隔；宽限期 0 关闭 |

## 安全模型

- **对 DSH 隐形**：`Host` 重写为 `127.0.0.1:3080`，丢弃 `Origin`/`Referer`/`X-Forwarded-*` 等，网关 Cookie 不上行——上游看来与本机浏览器完全不可区分。
- **对公网**：攻击面只有令牌登录一处。令牌 192 bit 随机、timing-safe 比较；Cookie `HttpOnly + SameSite=Lax`，HTTPS 下自动 `Secure`；错误令牌全局 30 次/分钟软限流（不依赖 IP——隧道拓扑下 IP 逻辑无效，见 [`PITFALLS.md`](PITFALLS.md) §4）。`/pwa/*` 静态资产豁免认证（iOS 装图标不带 Cookie）。
- **lan 模式**：HTTP 明文，令牌与流量同网可嗅探；防火墙是唯一网络边界（只放行「专用网络」）。
- **cf 模式**：TLS 在 CF 边缘终止，明文对 CF 可见；quick tunnel 官方定位测试用途，无 SLA；登录链接不要发给不可信方。
- **控制面板**：只绑 `127.0.0.1`；登录复用网关令牌；所有写操作要求 `X-DG-Admin` 自定义头（本机其他网页过不了 CORS 预检，无法静默改配置）。

## 测试

```bash
npm test   # 85 项：mock 上游 + 网关/面板/配置库/补丁锚点等
```

真机端到端清单见 [`TESTING.md`](TESTING.md)；踩坑记录与修复设计见 [`PITFALLS.md`](PITFALLS.md)；开发约束与文件职责见 [`AGENTS.md`](AGENTS.md)。

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `gateway.mjs` | 网关本体：令牌认证 + 反代 + WS 隧道 + PWA 注入 + 流量统计 + 长响应保活 |
| `start.mjs` / `start.bat` | 一键启动（面板 + dsh web + 网关 + 隧道，单窗口） |
| `admin.mjs` + `admin/` | 本地控制面板（QR 库、字体、图标均 vendored 于 `admin/vendor/`） |
| `config-lib.mjs` / `setup.mjs` | 配置读写校验 / 隧道参数构造纯函数库 |
| `patch-dsh.mjs` | 幂等补丁 DSH client-runtime（修提问弹窗、断帧修复改增量合并省流量） |
| `pwa/` | manifest、最小 service worker、图标 |
| `frp/` / `cf/` | frpc 模板 / cloudflared 放置目录 |
| `test/` | 六组自动化测试 |

## Roadmap

- [ ] 任务完成 Web Push 通知
- [ ] 多机路由（按电脑分子域名）
- [ ] cf 模式升级 named tunnel（固定域名）

## 致谢

- 设计灵感来自 [dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa)（MIT）与其上游 [dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate)（MIT）
- 图标来自 DSH 官方 favicon

## License

MIT
