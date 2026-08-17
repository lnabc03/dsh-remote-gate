# CLAUDE.md — dsh-remote-gate

最小化 DSH（DeepSeek Harness）远程访问网关：手机/平板经公网服务器（frp 或 SSH 反向隧道中转）、Cloudflare 临时隧道（cf 模式，零服务器）或同一局域网直连，安全操控本机 DSH Web UI，可安装为 PWA。私有仓库，计划完善后转公开。

## 技术栈与形态

> 踩坑的「为什么」索引见 [`PITFALLS.md`](PITFALLS.md)（面向使用者/后续开发者）；本文件是约束与文件职责的权威来源。

- 纯 Node ≥ 18，**零运行时依赖**，全部用 node: 内置模块——不要引入 npm 依赖（面板前端的 QR 库、Inter/JetBrains Mono 可变字体、鲸鱼图标是 vendored 资产 `admin/vendor/`，不是 npm 依赖，别换成包或 CDN 链接）
- `gateway.mjs` 是网关服务进程（ESM 单文件，保持自包含、不 import 本仓库其他文件）；`start.mjs` 是进程编排器 + 控制面板宿主；面板服务拆在 `admin.mjs`，配置读写在 `config-lib.mjs`，校验纯函数在 `setup.mjs`
- 测试：`npm test`（node:test + 起 mock 上游和网关子进程，端口随机化防冲突）
- Windows 为主要运行平台；`.bat` 文件**必须是纯 ASCII**（cmd 用 GBK 解析，UTF-8 中文会被当成乱码命令执行——踩过）

## 不可违反的设计约束（都是踩坑换来的）

1. **绝不引入任何基于 IP 的逻辑**。经 frp 后所有请求的 remoteAddress 都是 127.0.0.1，IP 审批/限流/本机栅栏在此拓扑下全部失效且有安全反效果（远端用户会被误判为"本机"）。认证只有令牌 + HttpOnly Cookie 一条路；防爆破用全局失败计数，不按 IP。
2. **转发给 DSH 的请求必须与本机浏览器访问不可区分**（dsh 对敏感 API 有本机风控）：Host 重写为 `127.0.0.1:3080`；丢弃 `Origin`/`Referer`/`X-Forwarded-*`/`X-Real-IP`/`Forwarded`；网关自身的 `dg_token` Cookie 不转发上游。改 `cleanHeaders` 时不要放宽。`Accept-Encoding` **只在导航请求（Accept 含 text/html，可能需要 HTML 注入）上摘除**，其余请求必须放行压缩——全量摘除会让 JS bundle 未压缩过隧道，按出站计费的服务器流量翻好几倍（踩过，半天近 1G）。且 dsh 上游自身完全不压缩（实测），**网关在出站侧对可压响应做 gzip**（>1KB、非流式、上游未压缩、客户端接受）——`GZIP_TYPE`/`mayGzip` 的豁免（event-stream、小响应、已压缩、非 200）勿删，流式响应必须保持逐块透传。
3. **HTML 注入点必须紧跟 `<head>` 之后**。dsh 自带 `<link rel="manifest">`（无 PNG 图标），浏览器只认文档中第一个 manifest 链接，注在 `</head>` 前会被它挤掉（安卓无法安装的根因）。
4. **`/pwa/*` 静态资产豁免认证**。iOS「添加到主屏幕」抓图标/manifest 不带会话 Cookie，拦 401 会丢图标。仅限这个前缀下的白名单文件，路径穿越防护不可删；未来 `/pwa/push/*` 这类动态端点必须另行鉴权，不能跟着豁免。
5. 注入改写响应体时，必须删掉 `Transfer-Encoding`/`Connection`/`Keep-Alive` 并重写 `Content-Length`——TE 与 CL 并存会被浏览器 fetch 拒收（踩过）。前提是导航请求的 `Accept-Encoding` 被摘掉（见约束 2）让上游返回未压缩 HTML，压缩字节不可注入。
6. **dsh 必须由 `start.mjs` 直接 `spawn(node, [dshBin, 'web'])` 启动，绝不能走 `npx`/`shell` 中转**。Windows 点窗口 X 关控制台发的是 `CTRL_CLOSE_EVENT`，Node 不触发 `SIGINT`/`SIGTERM`，`shutdown()` 里的 `taskkill /T` 根本不执行；`npx → cmd → dsh web` 深层进程脱离控制台成为孤儿（下次 `probeDsh` 复用残留，补丁/改动都不生效）。直接子进程则随控制台一起退出，Ctrl+C 的 `taskkill /T` 也少两层中间进程、杀得更干净。
7. **ssh 反向隧道**：`ssh -R 3088:127.0.0.1:3088`，`remotePort` 固定 3088（服务器反代硬编码指向它，别改）。认证只用密钥（复用已有私钥，`-i` 指定路径），`BatchMode=yes` 拒绝密码交互；`StrictHostKeyChecking=yes`（预先录入 known_hosts，否则拒连——防中间人），**绝不放宽成 `accept-new`/`no`**。重连在 Node 内手写（退出 3s 重拨、不团灭），**不要引入 autossh**（零依赖约束）。ssh 进程非致命、frpc/cloudflared 致命：别把 ssh 的退出语义与 frpc/cf 的「退出=团灭」混同。
8. **lan 局域网模式**：`mode:"lan"` 下网关绑 `0.0.0.0`（`DSH_GATE_BIND` 可覆盖），`start.mjs` 不启动任何隧道。明文 HTTP 是已接受的取舍（Android 丢完整 PWA + SW，iPhone 仍可 web clip；令牌可被同网嗅探）——**不要试图为 lan 加自签 HTTPS / 本地 CA**。防火墙是唯一网络边界：只提示用户放行「专用网络」，**程序不改系统防火墙**。仍不引入按 IP 的逻辑（约束 1 不因 lan 出现真实来源 IP 而破例）。
9. **cf 模式（Cloudflare quick tunnel）**：`mode:"cf"` 下 `start.mjs` 拉起 `cf/cloudflared`（`--no-autoupdate tunnel --url http://127.0.0.1:3088`），无账号/域名/凭证。临时域名每次启动随机 → **登录链接必须由 start.mjs 抓 URL 后打印**（网关无从得知域名，别在 gateway.mjs 里瞎拼）。cloudflared 退出 = 域名失效 = **团灭**（重拨必换 URL，与 ssh 的「重拨入口不变」语义相反，勿混用）。CF 边缘不保证发 `X-Forwarded-Proto`，网关 cf 模式用 `FORCE_HTTPS` 强制 Cookie `Secure`——**勿删**。CF 免费层 100s 无响应硬超时（524）是产品限制：网关 drip 保活（`DSH_GATE_DRIP_*`）在宽限期内抢先给首字节并周期滴包，预期可绕开（未经长期实机验证），若仍遇 524 属 CF 限制、勿在网关层硬怼。
10. **控制面板（admin.mjs + admin/）**：**只绑 127.0.0.1**——面板是本机控制台，手机/局域网/公网都无权访问，这是产品决策而非缺陷，别加远程访问面板的口子。鉴权复用 config.json 网关令牌（`?t=` → `dg_admin` Cookie，HttpOnly + SameSite=Strict）；**所有 POST 必须校验 `X-DG-Admin` 自定义头**（防本机恶意网页 CSRF/localhost 扫描，跨站请求过不了 CORS 预检带不了自定义头）——该防线勿删。约束 1 不破例：面板不做任何按 remoteAddress 的请求判断，127.0.0.1 只是绑址。
11. **config.json 是唯一配置数据源**：frp 参数也存 `config.json.frp`（serverAddr/serverPort/authToken），`frp/frpc.toml` 只是 `applyPanelConfig`/启动时全量重生成的产物——勿手动编辑、勿在代码里把它当数据源回读（迁移入口只有 `migrateFrpIntoConfig` 一处）。写 config.json 必须走 `saveConfigAtomic`（临时文件 + rename，防写一半留坏文件）。**面板保存 = 重启网关+隧道，dsh 不动**（重启 dsh 会杀掉正在跑的 agent 会话）；start.mjs 用进程代际（gen）区分「面板主动重启」与「意外崩溃」——旧进程的退出/重连回调随 gen 失效，不得触发团灭逻辑。

## 文件与职责

| 路径 | 职责 | 改动注意 |
| --- | --- | --- |
| `gateway.mjs` | 令牌认证 + 反代 + WS 隧道 + manifest 注入 + 流量统计（每小时一行 ↓↑ 字节 + 下行 top3 路径热点榜 `路径 字节×次数`，静默时段不刷）+ 长响应保活（drip + 102 心跳） | 改完必跑 `npm test`；下行口径 = 写回浏览器侧字节（post-gzip，即过隧道计费口径），勿改回上游侧计数；**102 心跳只在「等上游响应头」阶段发送**（`DSH_GATE_HEARTBEAT_MS`，默认 25s），上游响应头一到必停——`res.headersSent` 后再 writeProcessing 会毁流，清定时器的三个位置（upRes 回调/error/close）勿删；**WebKit UA（iOS 全系浏览器 + Mac Safari）不发 102**——其 fetch 遇 1xx 中间响应，最终响应到达时直接报 `Load failed`（命令其实已在服务端执行完，踩过）；**drip（仅 POST `/api/commands/execute`）**：宽限期（`DSH_GATE_DRIP_GRACE_MS` 默认 20s）后上游仍未响应则抢先提交 200+chunked、每 `DSH_GATE_DRIP_MS`（默认 25s）滴一个空格 chunk 保活（JSON 容忍前导空白），drip 路径须摘除发往上游请求的 accept-encoding（已提交响应无法再声明 content-encoding）且不再 arm 102 心跳；宽限期后才到达的非 200 状态无法传达（客户端按 200 收错误正文，有意取舍）；保持单文件自包含 |
| `start.mjs` | 进程编排 + 面板宿主：拉起面板/dsh/网关/隧道，单窗口日志加前缀 | dsh 崩溃自动重启（5 次×3s）；网关/frpc/cloudflared **意外**退出团灭，ssh 退出 3s 重拨（约束 7）；面板保存触发的重启靠 gen 代际区分，别绕过 stopGate/stopTunnel 直接 kill；**热重启必须 await `waitExit` 等旧进程退出释放端口再拉新**——killTree 是异步的（Windows 走 taskkill），立即 spawn 新网关会 EADDRINUSE 秒退，被 exit 回调误判为意外崩溃 → 团灭（踩过）；cf 临时域名由 startCfProc 抓日志（`extractCfUrl`）→ 拼令牌打印 + 推面板；dsh 直接 spawn node bin.js（约束 6），杀派生树用 `taskkill /T`；`--no-ui` 关闭面板；**面板应用窗口生死与本进程耦合**：shutdown() 主动 `killPanelBrowser`，意外死亡由 `watchdog.mjs` 兜底；控制台 stdin 按回车 = 重开面板窗口（start.bat 用 `start /min` 把控制台最小化，bat 自身 `exit /b` 闪退，保持纯 ASCII）；**`openInBrowser` 拉窗后异步验证**（`panelBrowserState`/`parsePanelBrowserState`）：chromium `--app` 窗口偶发「进程在、无可见窗口」（强杀重启后尤甚，清 crash 标记无效），12s 内未见窗口则再 spawn 一次经单例 handoff 拉窗（实测 ~1s）；窗口已可见则跳过 spawn 防双窗——勿删此兜底 |
| `watchdog.mjs` | 面板看门狗（detached、无控制台）：轮询父进程（start.mjs）存活，父死则按命令行中的面板专用 profile 路径关闭面板浏览器进程树并自杀；`killPanelBrowser` 同时导出给 shutdown() 用 | 存在原因 = CTRL_CLOSE_EVENT 下 Node 无任何清理回调（约束 6 同源），面板窗口会静默挂着；匹配串（`panelProfileDir()`）只命中面板专用 profile 的浏览器进程树，默认浏览器标签页模式天然不受影响；看门狗自身命令行也含该路径，PowerShell 枚举必须排除自身与 `$PID`；先 CloseMainWindow 温和关窗、1.5s 后强杀兜底 |
| `admin.mjs` + `admin/` | 本地控制面板：HTTP 服务（认证/CSRF/SSE 日志流）+ 前端（vanilla JS） | 约束 10；静态文件白名单 `STATIC_FILES` 闭集，加新文件要同步登记；前端 CSP `default-src 'self'`，别引入内联脚本/外部 CDN；令牌轮换后 POST 响应须 Set-Cookie 换新（否则面板把自己锁外面） |
| `config-lib.mjs` | config.json 读写（`saveConfigAtomic`）、面板表单校验（`validatePanelConfig`）、frpc.toml 迁移与生成、`isConfigured`/`preflightForMode` | 约束 11；表单空串语义 = 「未改动」回退 existing（`pick` 助手），别用 `??` 挡空串——踩过 |
| `setup.mjs` | 纯函数库：字段校验、frpc.toml 渲染/解析、ssh 参数构造与连通性自检 | 交互式配置已删除（面板取代），勿再加 readline 提问；改校验/渲染/ssh 参数必跑 `npm test` |
| `patch-dsh.mjs` | 幂等补丁 DSH client-runtime：A. 修复提问弹窗被重连刷没；B. repairGap/doOpen 断帧修复从「整页重拉 + 整窗替换」改为 `repairTailMerge` 增量合并最小尾页（1→5→50 条消息逐级放大，50 仍够不到旧窗尾才退回整窗替换） | 锚点严格 LF + Tab；逐锚点幂等（marker 命中即跳过，兼容只打过 A 组的旧文件），别把幂等判断改回全局早退；改锚点先跑 `npm test`；B 组依赖「窗口内事件不可变、appendLive 按 seq 去重」的运行时语义，若 dsh 升级改变这两点需重新评估 |
| `pwa/sw.js` | 最小 SW，只为满足 Chrome 可安装性；**不做缓存**（下拉误刷新类 bug 的教训），v2 推送的 push 事件也加在这里 | |
| `pwa/icons/` | dsh 官方鲸鱼 logo（白底黑鲸，maskable 版缩到 68% 保安全区） | 源文件是 dsh 的 `/favicon.svg` |
| `frp/frpc.toml.example` | 隧道配置模板 | 真实 `frpc.toml` 含 token，已 gitignore；且它只是生成产物（约束 11） |
| `cf/` | cloudflared 二进制放置目录 + 下载指引 | 二进制已 gitignore；下载方式见 `cf/README.md` |

## 密钥纪律

`config.json`（网关令牌）、`frp/frpc.toml`（frp token）、`.dsh-usage-stats.json` 都在 `.gitignore`，任何改动不得把它们带入暂存区。README 与示例文件只写占位符，不写真实域名/IP/token。ssh 模式的私钥本体在用户 `~/.ssh/` 下（`config.json` 只存 `ssh.keyPath` 路径），不进仓库、无需 gitignore。

## 隧道拓扑要点

- 网关绑址按 `config.json.mode`（`DSH_GATE_BIND` 可覆盖）：frp/ssh/cf → `127.0.0.1`（公网入口 = 服务器反代或 CF 边缘，TLS 终止；frp/ssh 靠 `X-Forwarded-Proto: https` 决定 Cookie 是否 `Secure`，cf 由 `FORCE_HTTPS` 强制），lan → `0.0.0.0`（局域网直连，HTTP 明文）。frp/ssh 两种隧道都把服务器 `127.0.0.1:3088` 回灌到本机 gateway，反代侧无感知；cf 由本机 cloudflared 出站直连 CF 边缘
- **frp**：frps 端 `transport.maxPoolCount` 必须与 frpc 端 `transport.poolCount`（当前 20）对齐，否则刷 `work connection pool is full`（移动端加载 SPA 并发几十个连接所致）
- **ssh**：服务器需 sshd + `AllowTcpForwarding yes`，无需 `GatewayPorts`（反向隧道默认只绑 loopback）；`remotePort` 固定 3088；私钥公钥需预先加入 `authorized_keys`，首次连接前先手动 `ssh` 一次录入 known_hosts。已实测基本可用（稳定性略逊于 frp、流式输出略卡，属预期）
- **lan**：无需服务器/隧道/字段；`start.mjs` 跳过隧道分支；网关打印 `http://<局域网IP>:3088/?t=…`。IP 用 UDP connect 探测默认路由网卡得出（直接枚举第一个会踩中 VMware/Hyper-V 虚拟网卡，手机永远够不到——踩过），横幅附其余候选 IP 供手动替换。明文 + 防火墙提示已文档化；校园网/企业 Wi-Fi 常开 AP 客户端隔离导致同网设备互不可达（环境问题，开热点排除）。明文 HTTP 是非安全上下文，浏览器不提供 `crypto.randomUUID`（dsh 前端选工作区/改设置会抛错），lan 模式注入 `getRandomValues` polyfill 解决——**勿删**，frp/ssh（HTTPS）不注入。热点环境真机已实测可用（进页面/选工作区/改设置均正常）

## v2 待办（用户已明确推迟，别主动做）

- 任务完成 Web Push（iPhone 走标准 Web Push，用 `web-push` 库做 VAPID + 加密；参考实现 dsh-mobile-pwa 的推送链路是死代码，**不可照抄**：未加密未签名、订阅存内存、hook 名是猜的）
- 「任务完成」检测需先查 dsh 真实的 turn-end 事件名，写迷你 cordis 插件 POST 给网关
- 多机路由：按电脑分子域名 + 隧道（frp/ssh）配置模板化（frps 不允许两个代理共用 remotePort，ssh 反向隧道同理每个 remotePort 只能被一条连接占用；会话状态是各机本地的，不可用）。lan 模式无此问题——各机各自用局域网 IP/端口直连
