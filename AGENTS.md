# CLAUDE.md — dsh-remote-gate

最小化 DSH（DeepSeek Harness）远程访问网关：手机/平板经公网服务器（frp 中转）安全操控本机 DSH Web UI，可安装为 PWA。私有仓库，计划完善后转公开。

## 技术栈与形态

- 纯 Node ≥ 18，**零运行时依赖**，全部用 node: 内置模块——不要引入 npm 依赖
- `gateway.mjs` 是唯一服务进程（ESM 单文件）；`start.mjs` 是进程编排器
- 测试：`npm test`（node:test + 起 mock 上游和网关子进程，端口随机化防冲突）
- Windows 为主要运行平台；`.bat` 文件**必须是纯 ASCII**（cmd 用 GBK 解析，UTF-8 中文会被当成乱码命令执行——踩过）

## 不可违反的设计约束（都是踩坑换来的）

1. **绝不引入任何基于 IP 的逻辑**。经 frp 后所有请求的 remoteAddress 都是 127.0.0.1，IP 审批/限流/本机栅栏在此拓扑下全部失效且有安全反效果（远端用户会被误判为"本机"）。认证只有令牌 + HttpOnly Cookie 一条路；防爆破用全局失败计数，不按 IP。
2. **转发给 DSH 的请求必须与本机浏览器访问不可区分**（dsh 对敏感 API 有本机风控）：Host 重写为 `127.0.0.1:3080`；丢弃 `Origin`/`Referer`/`X-Forwarded-*`/`X-Real-IP`/`Forwarded`/`Accept-Encoding`；网关自身的 `dg_token` Cookie 不转发上游。改 `cleanHeaders` 时不要放宽。
3. **HTML 注入点必须紧跟 `<head>` 之后**。dsh 自带 `<link rel="manifest">`（无 PNG 图标），浏览器只认文档中第一个 manifest 链接，注在 `</head>` 前会被它挤掉（安卓无法安装的根因）。
4. **`/pwa/*` 静态资产豁免认证**。iOS「添加到主屏幕」抓图标/manifest 不带会话 Cookie，拦 401 会丢图标。仅限这个前缀下的白名单文件，路径穿越防护不可删；未来 `/pwa/push/*` 这类动态端点必须另行鉴权，不能跟着豁免。
5. 注入改写响应体时，必须删掉 `Transfer-Encoding`/`Connection`/`Keep-Alive` 并重写 `Content-Length`——TE 与 CL 并存会被浏览器 fetch 拒收（踩过）。前提是把 `Accept-Encoding` 摘掉让上游返回未压缩内容，压缩字节不可注入。
6. **dsh 必须由 `start.mjs` 直接 `spawn(node, [dshBin, 'web'])` 启动，绝不能走 `npx`/`shell` 中转**。Windows 点窗口 X 关控制台发的是 `CTRL_CLOSE_EVENT`，Node 不触发 `SIGINT`/`SIGTERM`，`shutdown()` 里的 `taskkill /T` 根本不执行；`npx → cmd → dsh web` 深层进程脱离控制台成为孤儿（下次 `probeDsh` 复用残留，补丁/改动都不生效）。直接子进程则随控制台一起退出，Ctrl+C 的 `taskkill /T` 也少两层中间进程、杀得更干净。

## 文件与职责

| 路径 | 职责 | 改动注意 |
| --- | --- | --- |
| `gateway.mjs` | 令牌认证 + 反代 + WS 隧道 + manifest 注入 | 改完必跑 `npm test` |
| `start.mjs` | 拉起 dsh web + 网关 + frpc，单窗口日志加前缀 | dsh 崩溃自动重启；网关/frpc 退出则团灭；dsh 直接 spawn node bin.js（见约束 6），杀派生树用 `taskkill /T` |
| `setup.mjs` | 首次运行交互式配置（frp 隧道 + 公网域名） | 全量重写 `frpc.toml`；改校验/渲染必跑 `npm test` |
| `patch-dsh.mjs` | 幂等补丁 DSH client-runtime（修复提问弹窗被重连刷没） | 锚点严格 LF + Tab；改锚点先跑 `npm test` |
| `pwa/sw.js` | 最小 SW，只为满足 Chrome 可安装性；**不做缓存**（下拉误刷新类 bug 的教训），v2 推送的 push 事件也加在这里 | |
| `pwa/icons/` | dsh 官方鲸鱼 logo（白底黑鲸，maskable 版缩到 68% 保安全区） | 源文件是 dsh 的 `/favicon.svg` |
| `frp/frpc.toml.example` | 隧道配置模板 | 真实 `frpc.toml` 含 token，已 gitignore |

## 密钥纪律

`config.json`（网关令牌）、`frp/frpc.toml`（frp token）、`.dsh-usage-stats.json` 都在 `.gitignore`，任何改动不得把它们带入暂存区。README 与示例文件只写占位符，不写真实域名/IP/token。

## frp 拓扑要点

- frps 端 `transport.maxPoolCount` 必须与 frpc 端 `transport.poolCount`（当前 20）对齐，否则刷 `work connection pool is full`（移动端加载 SPA 并发几十个连接所致）
- 网关只绑 127.0.0.1，公网入口 = 服务器反代（TLS 终止 + `X-Forwarded-Proto: https`，后者决定 Cookie 是否加 `Secure`）

## v2 待办（用户已明确推迟，别主动做）

- 任务完成 Web Push（iPhone 走标准 Web Push，用 `web-push` 库做 VAPID + 加密；参考实现 dsh-mobile-pwa 的推送链路是死代码，**不可照抄**：未加密未签名、订阅存内存、hook 名是猜的）
- 「任务完成」检测需先查 dsh 真实的 turn-end 事件名，写迷你 cordis 插件 POST 给网关
- 多机路由：按电脑分子域名 + frpc 配置模板化（frps 不允许两个代理共用 remotePort；frp 负载均衡组会在多机间随机分发，会话状态是各机本地的，不可用）
