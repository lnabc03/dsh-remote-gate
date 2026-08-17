# CLAUDE.md — dsh-remote-gate

最小化 DSH（DeepSeek Harness）远程访问网关：手机/平板经公网服务器（frp 或 SSH 反向隧道中转）或同一局域网直连，安全操控本机 DSH Web UI，可安装为 PWA。私有仓库，计划完善后转公开。

## 技术栈与形态

- 纯 Node ≥ 18，**零运行时依赖**，全部用 node: 内置模块——不要引入 npm 依赖
- `gateway.mjs` 是唯一服务进程（ESM 单文件）；`start.mjs` 是进程编排器
- 测试：`npm test`（node:test + 起 mock 上游和网关子进程，端口随机化防冲突）
- Windows 为主要运行平台；`.bat` 文件**必须是纯 ASCII**（cmd 用 GBK 解析，UTF-8 中文会被当成乱码命令执行——踩过）

## 不可违反的设计约束（都是踩坑换来的）

1. **绝不引入任何基于 IP 的逻辑**。经 frp 后所有请求的 remoteAddress 都是 127.0.0.1，IP 审批/限流/本机栅栏在此拓扑下全部失效且有安全反效果（远端用户会被误判为"本机"）。认证只有令牌 + HttpOnly Cookie 一条路；防爆破用全局失败计数，不按 IP。
2. **转发给 DSH 的请求必须与本机浏览器访问不可区分**（dsh 对敏感 API 有本机风控）：Host 重写为 `127.0.0.1:3080`；丢弃 `Origin`/`Referer`/`X-Forwarded-*`/`X-Real-IP`/`Forwarded`；网关自身的 `dg_token` Cookie 不转发上游。改 `cleanHeaders` 时不要放宽。`Accept-Encoding` **只在导航请求（Accept 含 text/html，可能需要 HTML 注入）上摘除**，其余请求必须放行压缩——全量摘除会让 JS bundle 未压缩过隧道，按出站计费的服务器流量翻好几倍（踩过，半天近 1G）。且 dsh 上游自身完全不压缩（实测），**网关在出站侧对可压响应做 gzip**（>1KB、非流式、上游未压缩、客户端接受）——`GZIP_TYPE`/`mayGzip` 的豁免（event-stream、小响应、已压缩、非 200）勿删，流式响应必须保持逐块透传。
3. **HTML 注入点必须紧跟 `<head>` 之后**。dsh 自带 `<link rel="manifest">`（无 PNG 图标），浏览器只认文档中第一个 manifest 链接，注在 `</head>` 前会被它挤掉（安卓无法安装的根因）。
4. **`/pwa/*` 静态资产豁免认证**。iOS「添加到主屏幕」抓图标/manifest 不带会话 Cookie，拦 401 会丢图标。仅限这个前缀下的白名单文件，路径穿越防护不可删；未来 `/pwa/push/*` 这类动态端点必须另行鉴权，不能跟着豁免。
5. 注入改写响应体时，必须删掉 `Transfer-Encoding`/`Connection`/`Keep-Alive` 并重写 `Content-Length`——TE 与 CL 并存会被浏览器 fetch 拒收（踩过）。前提是导航请求的 `Accept-Encoding` 被摘掉（见约束 2）让上游返回未压缩 HTML，压缩字节不可注入。
6. **dsh 必须由 `start.mjs` 直接 `spawn(node, [dshBin, 'web'])` 启动，绝不能走 `npx`/`shell` 中转**。Windows 点窗口 X 关控制台发的是 `CTRL_CLOSE_EVENT`，Node 不触发 `SIGINT`/`SIGTERM`，`shutdown()` 里的 `taskkill /T` 根本不执行；`npx → cmd → dsh web` 深层进程脱离控制台成为孤儿（下次 `probeDsh` 复用残留，补丁/改动都不生效）。直接子进程则随控制台一起退出，Ctrl+C 的 `taskkill /T` 也少两层中间进程、杀得更干净。
7. **ssh 反向隧道**：`ssh -R 3088:127.0.0.1:3088`，`remotePort` 固定 3088（服务器反代硬编码指向它，别改）。认证只用密钥（复用已有私钥，`-i` 指定路径），`BatchMode=yes` 拒绝密码交互；`StrictHostKeyChecking=yes`（预先录入 known_hosts，否则拒连——防中间人），**绝不放宽成 `accept-new`/`no`**。重连在 Node 内手写（退出 3s 重拨、不团灭），**不要引入 autossh**（零依赖约束）。ssh 进程非致命、frpc 致命：别把 ssh 的退出语义与 frpc 的「退出=团灭」混同。
8. **lan 局域网模式**：`mode:"lan"` 下网关绑 `0.0.0.0`（`DSH_GATE_BIND` 可覆盖），`start.mjs` 不启动任何隧道。明文 HTTP 是已接受的取舍（Android 丢完整 PWA + SW，iPhone 仍可 web clip；令牌可被同网嗅探）——**不要试图为 lan 加自签 HTTPS / 本地 CA**。防火墙是唯一网络边界：只提示用户放行「专用网络」，**程序不改系统防火墙**。仍不引入按 IP 的逻辑（约束 1 不因 lan 出现真实来源 IP 而破例）。

## 文件与职责

| 路径 | 职责 | 改动注意 |
| --- | --- | --- |
| `gateway.mjs` | 令牌认证 + 反代 + WS 隧道 + manifest 注入 + 流量统计（每小时一行 ↓↑ 字节，静默时段不刷） | 改完必跑 `npm test` |
| `start.mjs` | 拉起 dsh web + 网关 + 隧道（frp/ssh）或 lan 直连，单窗口日志加前缀 | dsh 崩溃自动重启；网关/frpc 退出则团灭，ssh 退出则 3s 重拨（不团灭，见约束 7），lan 模式不启动隧道；dsh 直接 spawn node bin.js（见约束 6），杀派生树用 `taskkill /T` |
| `setup.mjs` | 首次运行交互式配置（访问模式 frp/ssh/lan + 公网域名 + SSH 连通性自检） | frp 全量重写 `frpc.toml`；ssh 写 `config.json` 的 `mode`/`ssh.*`；lan 只写 `mode:"lan"`；改校验/渲染/ssh 参数必跑 `npm test` |
| `patch-dsh.mjs` | 幂等补丁 DSH client-runtime（修复提问弹窗被重连刷没） | 锚点严格 LF + Tab；改锚点先跑 `npm test` |
| `pwa/sw.js` | 最小 SW，只为满足 Chrome 可安装性；**不做缓存**（下拉误刷新类 bug 的教训），v2 推送的 push 事件也加在这里 | |
| `pwa/icons/` | dsh 官方鲸鱼 logo（白底黑鲸，maskable 版缩到 68% 保安全区） | 源文件是 dsh 的 `/favicon.svg` |
| `frp/frpc.toml.example` | 隧道配置模板 | 真实 `frpc.toml` 含 token，已 gitignore |

## 密钥纪律

`config.json`（网关令牌）、`frp/frpc.toml`（frp token）、`.dsh-usage-stats.json` 都在 `.gitignore`，任何改动不得把它们带入暂存区。README 与示例文件只写占位符，不写真实域名/IP/token。ssh 模式的私钥本体在用户 `~/.ssh/` 下（`config.json` 只存 `ssh.keyPath` 路径），不进仓库、无需 gitignore。

## 隧道拓扑要点

- 网关绑址按 `config.json.mode`（`DSH_GATE_BIND` 可覆盖）：frp/ssh → `127.0.0.1`（公网入口 = 服务器反代，TLS 终止 + `X-Forwarded-Proto: https` 决定 Cookie 是否 `Secure`），lan → `0.0.0.0`（局域网直连，HTTP 明文）。两种隧道都把服务器 `127.0.0.1:3088` 回灌到本机 gateway，反代侧无感知
- **frp**：frps 端 `transport.maxPoolCount` 必须与 frpc 端 `transport.poolCount`（当前 20）对齐，否则刷 `work connection pool is full`（移动端加载 SPA 并发几十个连接所致）
- **ssh**：服务器需 sshd + `AllowTcpForwarding yes`，无需 `GatewayPorts`（反向隧道默认只绑 loopback）；`remotePort` 固定 3088；私钥公钥需预先加入 `authorized_keys`，首次连接前先手动 `ssh` 一次录入 known_hosts。已实测基本可用（稳定性略逊于 frp、流式输出略卡，属预期）
- **lan**：无需服务器/隧道/字段；`start.mjs` 跳过隧道分支；网关打印 `http://<局域网IP>:3088/?t=…`。IP 用 UDP connect 探测默认路由网卡得出（直接枚举第一个会踩中 VMware/Hyper-V 虚拟网卡，手机永远够不到——踩过），横幅附其余候选 IP 供手动替换。明文 + 防火墙提示已文档化；校园网/企业 Wi-Fi 常开 AP 客户端隔离导致同网设备互不可达（环境问题，开热点排除）。明文 HTTP 是非安全上下文，浏览器不提供 `crypto.randomUUID`（dsh 前端选工作区/改设置会抛错），lan 模式注入 `getRandomValues` polyfill 解决——**勿删**，frp/ssh（HTTPS）不注入。热点环境真机已实测可用（进页面/选工作区/改设置均正常）

## v2 待办（用户已明确推迟，别主动做）

- 任务完成 Web Push（iPhone 走标准 Web Push，用 `web-push` 库做 VAPID + 加密；参考实现 dsh-mobile-pwa 的推送链路是死代码，**不可照抄**：未加密未签名、订阅存内存、hook 名是猜的）
- 「任务完成」检测需先查 dsh 真实的 turn-end 事件名，写迷你 cordis 插件 POST 给网关
- 多机路由：按电脑分子域名 + 隧道（frp/ssh）配置模板化（frps 不允许两个代理共用 remotePort，ssh 反向隧道同理每个 remotePort 只能被一条连接占用；会话状态是各机本地的，不可用）。lan 模式无此问题——各机各自用局域网 IP/端口直连
