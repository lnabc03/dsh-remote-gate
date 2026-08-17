# dsh-remote-gate

> 最小化的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）远程访问网关：手机/平板经公网服务器（frp 或 SSH 反向隧道中转）或同一局域网直连，安全操控本机的 DSH Web UI，可安装为 PWA。

单文件、零依赖（Node ≥ 18），只做三件事：**令牌认证 · 反向代理（含 WebSocket）· PWA manifest 注入**。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

## 为什么需要它

1. **DSH 的本机风控**：DSH Web UI 对工作区、设置、凭证等敏感 API 要求请求必须来自 `127.0.0.1`，直接 frp 暴露 3080 端口会被拦截。本网关在本机代理，并抹平一切「非本机访问」痕迹（详见下文安全模型）。
2. **移动端可用性**：注入 manifest 与安装 meta，手机「添加到主屏幕」即成为全屏独立 App（iOS/Android 均支持）。

## 架构

```
公网（frp / ssh 模式）：
手机/平板 ──HTTPS──> 公网服务器（反代 TLS 终止）──隧道（frp 或 SSH 反向）──> 本机 127.0.0.1:3088（本网关）──> 127.0.0.1:3080（DSH Web UI）

局域网（lan 模式）：
手机/平板 ──HTTP──> 本机 0.0.0.0:3088（本网关）──> 127.0.0.1:3080（DSH Web UI）
```

- 网关默认只绑定 `127.0.0.1`（frp/ssh 模式，唯一入口是本地隧道，无公网暴露面）；`lan` 模式绑 `0.0.0.0` 供局域网直连（靠令牌一道闸，见安全模型）
- 认证为「共享令牌 + 每设备 Cookie」，无任何 IP 相关逻辑——经 frp/ssh 后所有来源都是 127.0.0.1，基于 IP 的审批/限流在这种拓扑下必然失效（这也是重写 [dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa) 的原因）
- 省流量：dsh 上游自身不压缩，网关在出站侧对可压响应（JS/CSS/JSON 等，>1KB、非流式）做 gzip，vendor.js 级别资产过隧道体积约降到 1/3；HTML 导航请求仍强制未压缩（注入所需）；网关每小时打印一行 `[gate] 流量: …` 上下行字节汇总，按出站计费的服务器可据此直接观察资费

## 快速开始

```bash
git clone <repo> && cd dsh-remote-gate

# 一键启动（Windows 可直接双击 start.bat）；首次运行会交互式询问「模式 + 对应字段」
npm start
```

`npm start`（即 `start.mjs`）首次运行先问**访问模式**（`frp` / `ssh` / `lan`），再问对应字段，写入 `config.json`（frp 模式额外写 `frp/frpc.toml`），然后单窗口拉起进程，日志带 `[dsh]` / `[gate]` / `[frpc]` 或 `[ssh]` 前缀：

- 先探测 3080：dsh web 已在运行则跳过，否则直接 `spawn(node, [全局 dsh 的 bin.js, 'web'])`（不经过 npx/shell，避免关窗口残留孤儿进程）；崩溃自动重启（5 次 × 3s）
- 再启动网关与隧道；网关/frpc 退出则整体退出；ssh 隧道退出则自动重拨（不团灭）；Ctrl+C 全部终止

- **frp 模式**：需先下载 frpc（见下），问 frps 地址/端口（默认 7000）/token/域名
- **ssh 模式**：无需下载任何二进制（用系统自带 OpenSSH），问服务器地址/端口（默认 22）/用户名/私钥路径（默认 `~/.ssh/id_ed25519`）/域名
- **lan 模式**：无需服务器、无需任何字段，网关绑 `0.0.0.0` 局域网直连（首次可能弹 Windows 防火墙提示，点「允许」）。打印的 IP 按系统默认路由选取（自动避开 VMware/Hyper-V 虚拟网卡），横幅同时列出其余候选 IP 供替换；校园网/企业 Wi-Fi 常开 AP 客户端隔离导致手机够不到电脑，可用「手机开热点、电脑连热点」排除

已配置后每次启动都会跳过提问；`npm start -- --setup` 重新配置（现有值作默认，回车保留）；`--mode frp|ssh|lan` 切换模式。也支持命令行标志：`--server`、`--server-port`、`--auth-token`、`--ssh-host`、`--ssh-port`、`--ssh-user`、`--ssh-key`、`--domain`（`--help` 查看全部）。

网关首次运行生成随机访问令牌写入 `config.json`，启动日志会打印登录链接（lan 模式是局域网地址）：

```
https://<你的域名>/?t=<token>          # frp / ssh 模式
http://<本机局域网IP>:3088/?t=<token>   # lan 模式
```

手机浏览器打开一次该链接 → 种下一年有效的 HttpOnly Cookie → 之后直接访问该地址即可。

### 服务器侧

**lan 模式无需服务器**。frp/ssh 模式：反代（Nginx/Caddy）把域名 HTTPS 流量转到隧道暴露的端口，并带上 `X-Forwarded-Proto: https` 头（用于给 Cookie 加 `Secure`）。

**frp 模式**：frps 的 `frps.toml` 加 `transport.maxPoolCount = 20`（与 frpc 的 `poolCount` 对齐，否则刷 `work connection pool is full`）；反代转到的就是 frps 暴露的 `remotePort`（默认 3088）。

**ssh 模式**：服务器需已运行 sshd、账号可用、`sshd_config` 里 `AllowTcpForwarding yes`（反向隧道默认只绑 127.0.0.1，无需 `GatewayPorts`）；本机私钥对应的公钥要加入该账号的 `~/.ssh/authorized_keys`；首次连接前先在命令行手动 `ssh <用户>@<服务器>` 一次录入主机指纹。反代转到的就是 ssh 反向隧道绑定的 `127.0.0.1:3088`。

### 手机安装为 PWA

- **iOS**：Safari 打开 → 分享 →「添加到主屏幕」
- **Android**：用 Chrome/Edge 打开（厂商自带浏览器大多阉割了 PWA 安装），页面上点击几下并停留 30 秒以上（Chrome 的互动启发式硬条件），菜单 →「安装应用」
- 已知限制：无 Google Play 服务的 ROM 上 Chrome 无法铸造 WebAPK，会退化为普通快捷方式
- **lan 模式降级**：局域网是 HTTP 明文，浏览器不会注册 Service Worker、Android 无法安装为完整 PWA（退化为浏览器快捷方式）；iPhone 仍可「添加到主屏幕」成 web clip。完整 PWA 安装只在 frp/ssh 的 HTTPS 下可用。另：HTTP 非安全上下文下浏览器不提供 `crypto.randomUUID`，网关已在 lan 模式注入 polyfill（`getRandomValues` 实现），页面功能（选工作区/改设置等）不受影响

## 配置

| 来源 | 项 | 默认 | 说明 |
| --- | --- | --- | --- |
| env | `DSH_GATE_PORT` | `3088` | 监听端口 |
| env | `DSH_GATE_BIND` | 按模式 | 监听地址；缺省按 `config.json.mode`：`lan` → `0.0.0.0`，其余 → `127.0.0.1` |
| env | `DSH_GATE_CONFIG` | 同目录 `config.json` | 配置文件路径（测试/多实例用） |
| env | `DSH_GATE_TARGET_PORT` | `3080` | DSH Web UI 端口 |
| env | `DSH_GATE_TOKEN` | — | 访问令牌（设置后不再读写 config.json） |
| env | `DSH_GATE_DOMAIN` | — | 公网域名，打印登录链接用（`config.json` 的 `domain` 同效；lan 模式忽略） |
| `config.json` | `token` / `port` / `targetPort` / `domain` | — | 同上，文件形式；`domain` 由 setup 写入 |
| `config.json` | `mode` | `frp` | 访问模式：`frp` / `ssh` / `lan`（缺省 frp，向后兼容） |
| `config.json` | `ssh.host` / `ssh.port` / `ssh.user` / `ssh.keyPath` | — | ssh 模式专用：服务器地址 / 端口（默认 22）/ 用户名 / 私钥路径 |

## 安全模型

**对 DSH 隐形**：上游连接由网关在本机发起（`remoteAddress` 恒为 127.0.0.1）；`Host` 重写为 `127.0.0.1:3080`；`Origin` / `Referer` / `X-Forwarded-*` / `X-Real-IP` / `Forwarded` 一律丢弃；网关自身的 Cookie 不转发上游。对 DSH 而言，所有流量与本机浏览器访问完全不可区分。

**对公网**：攻击面只有令牌登录一处。令牌 192 bit 随机、timing-safe 比较；Cookie `HttpOnly + SameSite=Lax`，HTTPS 下自动 `Secure`；错误令牌尝试全局 30 次/分钟软限流（不依赖 IP，frp 拓扑下安全）。`/pwa/*` 静态资产（图标/manifest/sw）豁免认证——iOS 安装图标时不带 Cookie，且这些文件无敏感信息。

**lan 模式**：连接是 HTTP 明文，令牌与全部流量在同网可被嗅探（威胁模型是「可信家庭 Wi-Fi」）；防火墙是唯一网络边界（绑定 `0.0.0.0` 时 Windows 会弹提示，请只放行「专用网络」）。

## 测试

```bash
npm test   # 起 mock 上游 + 网关子进程：认证/头清洗/HTML 注入顺序/静态资产/路径穿越
```

> 真机端到端（SSH 反向隧道 / LAN 局域网直连）的逐步清单见 [`TESTING.md`](TESTING.md)。

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `gateway.mjs` | 网关本体：令牌认证 + 反代 + WS 隧道 + manifest 注入 |
| `start.mjs` / `start.bat` | 一键启动（dsh web + 网关 + frp/ssh 隧道或 lan 直连，单窗口） |
| `setup.mjs` | 首次运行交互式配置（访问模式 frp/ssh/lan + 公网域名 + SSH 连通性自检） |
| `patch-dsh.mjs` | 幂等补丁 DSH client-runtime（修复提问弹窗被重连刷没） |
| `pwa/` | manifest.json、最小 service worker、图标（dsh 官方鲸鱼 logo） |
| `frp/frpc.toml.example` | frp 客户端配置模板 |
| `test/gateway.test.mjs` | 冒烟测试 |

## Roadmap

- [ ] 任务完成 Web Push 通知（iPhone 需先安装 PWA；触发端预留为网关上受信端点 + dsh 侧迷你插件订阅 turn-end 事件）
- [ ] 多机路由（按电脑分子域名，frpc 配置模板化）

## 致谢

- 设计灵感来自 [dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa)（MIT）与其上游 [dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate)（MIT）
- 图标来自 DSH 官方 favicon

## License

MIT
