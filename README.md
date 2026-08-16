# dsh-remote-gate

> 最小化的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）远程访问网关：手机/平板经公网服务器（frp 中转）安全操控本机的 DSH Web UI，可安装为 PWA。

单文件、零依赖（Node ≥ 18），只做三件事：**令牌认证 · 反向代理（含 WebSocket）· PWA manifest 注入**。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

## 为什么需要它

1. **DSH 的本机风控**：DSH Web UI 对工作区、设置、凭证等敏感 API 要求请求必须来自 `127.0.0.1`，直接 frp 暴露 3080 端口会被拦截。本网关在本机代理，并抹平一切「非本机访问」痕迹（详见下文安全模型）。
2. **移动端可用性**：注入 manifest 与安装 meta，手机「添加到主屏幕」即成为全屏独立 App（iOS/Android 均支持）。

## 架构

```
手机/平板 ──HTTPS──> 公网服务器（反代 TLS 终止）──frp──> 本机 127.0.0.1:3088（本网关）──> 127.0.0.1:3080（DSH Web UI）
```

- 网关只绑定 `127.0.0.1`，唯一入口是本地 frpc，无公网暴露面
- 认证为「共享令牌 + 每设备 Cookie」，无任何 IP 相关逻辑——经 frp 后所有来源都是 127.0.0.1，基于 IP 的审批/限流在这种拓扑下必然失效（这也是重写 [dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa) 的原因）

## 快速开始

```bash
git clone <repo> && cd dsh-remote-gate

# 1. 放入 frpc：从 https://github.com/fatedier/frp/releases 下载对应平台 release，
#    把 frpc 可执行文件放进 frp/ 目录
# 2. 一键启动（Windows 可直接双击 start.bat）；首次运行会交互式询问 frp 配置
npm start
```

`npm start`（即 `start.mjs`）首次运行会交互式询问 4 项——frps 服务器地址、端口（默认 7000）、认证 token、公网域名——写入 `frp/frpc.toml` 与 `config.json`，然后单窗口拉起三个进程，日志带 `[dsh]` / `[gate]` / `[frpc]` 前缀：

- 先探测 3080：dsh web 已在运行则跳过，否则直接 `spawn(node, [全局 dsh 的 bin.js, 'web'])`（不经过 npx/shell，避免关窗口残留孤儿进程）；崩溃自动重启（5 次 × 3s）
- 再启动网关与 frpc 隧道；任一关键进程退出则整体退出；Ctrl+C 全部终止

已配置后每次启动都会跳过提问；`npm start -- --setup` 重新配置（现有值作默认，回车保留）。也支持命令行标志：`--server`、`--server-port`、`--auth-token`、`--domain`（`--help` 查看全部）。

网关首次运行生成随机访问令牌写入 `config.json`，启动日志会打印登录链接：

```
https://<你的域名>/?t=<token>
```

手机浏览器打开一次该链接 → 种下一年有效的 HttpOnly Cookie → 之后直接访问域名即可。

### 服务器侧

1. frps 的 `frps.toml` 加 `transport.maxPoolCount = 20`（与 frpc 的 `poolCount` 对齐，否则刷 `work connection pool is full`）
2. 反代（Nginx/Caddy）把域名 HTTPS 流量转到 frps 暴露的端口，并带上 `X-Forwarded-Proto: https` 头（用于给 Cookie 加 `Secure`）

### 手机安装为 PWA

- **iOS**：Safari 打开 → 分享 →「添加到主屏幕」
- **Android**：用 Chrome/Edge 打开（厂商自带浏览器大多阉割了 PWA 安装），页面上点击几下并停留 30 秒以上（Chrome 的互动启发式硬条件），菜单 →「安装应用」
- 已知限制：无 Google Play 服务的 ROM 上 Chrome 无法铸造 WebAPK，会退化为普通快捷方式

## 配置

| 来源 | 项 | 默认 | 说明 |
| --- | --- | --- | --- |
| env | `DSH_GATE_PORT` | `3088` | 监听端口（只绑 127.0.0.1） |
| env | `DSH_GATE_TARGET_PORT` | `3080` | DSH Web UI 端口 |
| env | `DSH_GATE_TOKEN` | — | 访问令牌（设置后不再读写 config.json） |
| env | `DSH_GATE_DOMAIN` | — | 公网域名，打印登录链接用（`config.json` 的 `domain` 同效） |
| `config.json` | `token` / `port` / `targetPort` / `domain` | — | 同上，文件形式；`domain` 由 setup 写入 |

## 安全模型

**对 DSH 隐形**：上游连接由网关在本机发起（`remoteAddress` 恒为 127.0.0.1）；`Host` 重写为 `127.0.0.1:3080`；`Origin` / `Referer` / `X-Forwarded-*` / `X-Real-IP` / `Forwarded` 一律丢弃；网关自身的 Cookie 不转发上游。对 DSH 而言，所有流量与本机浏览器访问完全不可区分。

**对公网**：攻击面只有令牌登录一处。令牌 192 bit 随机、timing-safe 比较；Cookie `HttpOnly + SameSite=Lax`，HTTPS 下自动 `Secure`；错误令牌尝试全局 30 次/分钟软限流（不依赖 IP，frp 拓扑下安全）。`/pwa/*` 静态资产（图标/manifest/sw）豁免认证——iOS 安装图标时不带 Cookie，且这些文件无敏感信息。

## 测试

```bash
npm test   # 起 mock 上游 + 网关子进程：认证/头清洗/HTML 注入顺序/静态资产/路径穿越
```

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `gateway.mjs` | 网关本体：令牌认证 + 反代 + WS 隧道 + manifest 注入 |
| `start.mjs` / `start.bat` | 一键启动（dsh web + 网关 + frpc，单窗口） |
| `setup.mjs` | 首次运行交互式配置（frp 隧道 + 公网域名） |
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
