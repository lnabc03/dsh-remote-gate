# 踩坑记录与修复设计

> 本项目在真实手机/隧道/反代环境踩过的坑，及对应的修复或有意取舍。面向后续开发者：改相关代码前先读对应条目。
> 约束的权威表述见 [`AGENTS.md`](AGENTS.md)；本文是「为什么」的索引。

## 1. 长响应与代理超时

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| `/compact` 等命令 60s 后 504，命令其实在服务端执行完了 | dsh 的 `POST /api/commands/execute` 是**同步长任务**，响应在执行完才一次性返回，期间零字节流动；Nginx 默认 `proxy_read_timeout 60s` 掐断 | **102 心跳**：等上游响应头期间每 25s 发一次 `102 Processing` 中间响应重置读超时（`DSH_GATE_HEARTBEAT_MS`）；仍建议反代显式 `proxy_read_timeout 600s` 双保险 |
| iOS 上 compact 成功执行后弹 `command.execute failed … Load failed` | WebKit（iOS 全系浏览器 + Mac Safari）的 fetch 不能正确处理 1xx 中间响应——收到若干 102 后，最终 200 到达时直接以 `Load failed` 拒绝（同类 bug：当年 Cloudflare 103 Early Hints 打挂 Safari） | **WebKit UA 自动豁免 102**；长命令改由 drip 兜底。dsh 客户端对 commands/execute 无超时，失败文案 `Load failed` 是 WebKit 特征（Chrome 为 `Failed to fetch`） |
| CF 免费层 100s 无响应硬超时（524），长命令必挂 | CF 产品限制（TTFP），用户不可调 | **drip**：仅 `POST /api/commands/execute`，上游超过宽限期（`DSH_GATE_DRIP_GRACE_MS`，默认 20s）未响应，抢先向客户端提交 `200 + chunked`，此后每 25s 滴一个空格 chunk 保活——有字节流动，沿途一切读超时（含 524）被重置；JSON 容忍前导空白，客户端 `response.json()` 无感。对 WebKit 同样安全。未经长期实机验证 |
| drip 路径上「宽限期后才失败的命令」客户端按 200 收到错误正文 | 响应行已提交，真实状态无法事后改写 | 有意取舍：命令校验类错误均秒回、不受影响；网关打一行日志记录真实状态。短命令（宽限期内响应）走正常透传，状态码原样 |
| 改过保活代码后流式输出损坏 | `res.headersSent` 之后再发 102 会毁流；定时器泄漏也会重复发 | 102 只在「等上游响应头」阶段发；上游响应头一到必停，清理点在 upRes 回调 / 上游 error / 客户端 close 三处，缺一不可。drip 路径不得再 arm 102，且必须摘除发往上游的 `accept-encoding`（已提交的响应无法再声明 content-encoding） |

## 2. 流量（按出站计费的服务器尤其要看）

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| 半天跑了近 1G 隧道流量 | 早期为注入 HTML 全量摘除 `Accept-Encoding`，导致 JS bundle 未压缩过隧道 | `Accept-Encoding` **只在导航请求**（Accept 含 text/html）摘除；dsh 上游自身完全不压缩（实测），**网关在出站侧对可压响应做 gzip**（>1KB、非流式、上游未压缩、客户端接受；event-stream 等豁免勿删），vendor.js 级资产约降到 1/3 |
| 手机弱网断帧修复一次拉几百 KB | dsh 断帧修复原实现「整页重拉 `session.history` + 整窗替换」：一页 50 条消息 4.7MB raw / 541KB gz | `patch-dsh.mjs` B 组补丁改 `repairTailMerge`：增量拉最小尾页（1→5→50 条逐级放大，50 仍够不到旧窗尾才退回整窗替换）+ `appendLive` 按 seq 去重合并；实测常见缺口 541KB gz → 57KB gz。**依赖「窗口内事件不可变」的运行时语义，dsh 升级后需重新评估锚点与语义** |
| 不知道流量花在哪 | — | 网关每小时打印一行 `[gate] 流量: ↓… ↑…`，下行口径 = 写回浏览器侧的 post-gzip 字节（即过隧道计费口径），并附下行 top3 路径热点榜 `路径 字节×次数`，区分「少量大响应」与「高频重拉」 |

## 3. Windows 进程管理

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| 点窗口 X 关掉控制台后，dsh 残留为孤儿；下次启动复用残留进程，补丁/改动不生效 | Windows 关控制台发 `CTRL_CLOSE_EVENT`，Node 不触发 `SIGINT`/`SIGTERM`，`shutdown()` 里的 `taskkill /T` 不执行；`npx → cmd → dsh` 的深层进程脱离控制台 | dsh 必须由 `start.mjs` 直接 `spawn(node, [dshBin, 'web'])` 启动，**绝不走 npx/shell 中转**：直接子进程随控制台退出 |
| 控制面板保存配置后整个栈「团灭」 | 热重启 kill 旧网关后立即 spawn 新网关：`taskkill` 是异步的，3088 未释放 → 新进程 EADDRINUSE 秒退 → 被 exit 回调误判为意外崩溃 → 触发团灭 | 热重启必须 `await waitExit` 等旧进程退出再拉新；另用进程代际（gen）区分「面板主动重启」与「意外崩溃」，旧进程的退出/重连回调随 gen 失效 |
| `.bat` 里写中文注释/提示变成乱码命令被执行 | cmd 用 GBK 解析批处理文件 | `.bat` 必须纯 ASCII |
| 面板 `--app` 窗口尺寸设置不生效 | Edge 已在运行时忽略 `--window-size` | 面板用隔离的用户数据目录（独立 profile）启动应用窗口 |
| 控制台被 X 掉 / 崩溃后，面板窗口静默挂着（SSE 断开、按钮失效，用户无从得知） | 同上：`CTRL_CLOSE_EVENT` 下 Node 无任何清理回调，面板应用窗口是独立浏览器进程，没人收尸 | **看门狗** `watchdog.mjs`（detached、无控制台，不随控制台死）：轮询父进程（start.mjs）存活，父死则按命令行中的面板专用 profile 路径精确关闭浏览器进程树后自杀；正常关停（Ctrl+C）由 `shutdown()` 主动 `killPanelBrowser()`，看门狗只兜底意外死亡；匹配串只命中专用 profile，不会误伤用户主浏览器；前端 SSE 断开 8s 亮离线横幅，补上「静默」的感知缺口 |
| 控制台里按回车重开面板要按**两次**才生效 | conhost 默认开 QuickEdit：鼠标一点窗口就进入「选择」态、输出冻结，第一次回车只是退出选择态，第二次才送到 node 的 stdin | `start.bat` 改为经 **PowerShell 宿主**拉起 node（pwsh 优先、powershell 回退）——PowerShell 启动时主动禁用 QuickEdit，点选不再冻结，回车一次即生效 |
| 启动后「命令行 + 面板」两个窗口，感知笨拙 | 控制台是生命周期所有者（面板由 start.mjs 托管，无法单独存活），但用户日常只需要面板 | `start.bat` 用 `start /min` 把控制台**最小化到任务栏**（日志仍在，点开即看），bat 自身 `exit /b` 闪退；面板窗口被误关时在控制台按回车重开 |
| 新设备上 `node start.mjs` 零输出、exit 0 秒退（双击 bat / npm start 同样无声失败，连崩溃日志都没有） | 该设备的仓库目录经**目录联接点（junction）**进入；Node 默认对主模块做 realpath，`import.meta.url` 拿到真实路径而 `process.argv[1]` 是链接路径 → `isMain` 严格相等判定失败 → `main()` 根本没执行 | 主入口判定改走 `samePath()`：先严格等，再 Windows 小写兜底，最后 `fs.realpathSync.native` 双向解析比真实路径；`--preserve-symlinks-main` 不改变 import.meta.url 已是 realpath 的事实，只能在判定侧兼容 |
| 新设备上早期崩溃「无声消失」（最小化控制台随进程一起没，什么痕迹都不留） | bat 以最小化窗口拉起 node，任何在打印日志前发生的崩溃都不可见 | `fatalCrash` 兜底：`uncaughtException`/`unhandledRejection`/`main()` 异常一律追加写 `start-crash.log`（含版本/平台/堆栈）再退出；控制台首行必打 node 版本横幅区分「node 没起来」与「脚本内崩溃」；浏览器/看门狗的 spawn 全部补 `'error'` 监听（异步 spawn 失败无监听器 = uncaughtException 炸掉整个启动器） |

## 4. 拓扑与网络

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| （设计前提）经 frp/ssh 后所有请求的 `remoteAddress` 都是 127.0.0.1 | 隧道在本机回灌 | **绝不引入任何基于 IP 的逻辑**：IP 审批/限流/「本机」栅栏在此拓扑下失效且有安全反效果（远端用户被误判为本机）。认证只有令牌 + HttpOnly Cookie；防爆破用全局失败计数（30 次/分钟），不按 IP |
| dsh 敏感 API（工作区/设置/凭证）被拦 | dsh 有本机风控，要求请求来自本机 | 网关转发必须与本机浏览器访问**不可区分**：`Host` 重写为 `127.0.0.1:3080`；丢弃 `Origin`/`Referer`/`X-Forwarded-*`/`X-Real-IP`/`Forwarded`；网关自身的 `dg_token` Cookie 不上行 |
| frps 日志刷 `work connection pool is full`，手机加载卡 | 移动端加载 SPA 并发几十个连接，frpc 预建连接池打满 | frps 端 `transport.maxPoolCount` 与 frpc 端 `transport.poolCount`（20）对齐 |
| ssh 首次连接被拒 | `StrictHostKeyChecking=yes` 下主机指纹未录入 | 设计如此（防中间人，**绝不放宽成 accept-new/no**）：首次前先手动 `ssh` 一次录入 known_hosts。私钥公钥预先入 `authorized_keys`，`BatchMode=yes` 拒绝密码交互 |
| 隧道断开后行为不一致 | frpc/cloudflared 退出 = 入口失效 = **团灭**；ssh 退出 = 入口不变，3s 自动重拨**不团灭** | 两种语义相反，勿混用：cf 重拨必换临时域名，静默失效不如明说；ssh 反向隧道 `remotePort` 固定 3088（反代硬编码指向它） |
| lan 模式打印的 IP 手机永远够不到 | 直接枚举第一个网卡会踩中 VMware/Hyper-V 虚拟网卡 | 用 UDP connect 探测默认路由网卡得出 IP，横幅附其余候选供手动替换 |
| lan 模式同 Wi-Fi 手机打不开 | 校园网/企业 Wi-Fi 常开 **AP 客户端隔离**，同网设备互不可达 | 环境问题非 bug：用「手机开热点、电脑连热点」排除 |
| lan 模式下 dsh 页面选工作区/改设置抛 `randomUUID is not a function` | 明文 HTTP 是非安全上下文，浏览器不提供 `crypto.randomUUID` | 网关在 lan 模式注入 `getRandomValues` polyfill（**勿删**；HTTPS 的 frp/ssh/cf 不注入） |

## 5. PWA 与浏览器行为

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| 安卓无法安装 PWA | dsh 自带一个无 PNG 图标的 `<link rel="manifest">`，**浏览器只认文档中第一个 manifest 链接**，我们的注在 `</head>` 前被它挤掉 | manifest 注入点必须**紧跟 `<head>` 之后** |
| 注入后页面 fetch 被拒收 | 改写响应体后 `Transfer-Encoding` 与 `Content-Length` 并存 | 注入时删掉 `Transfer-Encoding`/`Connection`/`Keep-Alive` 并重写 `Content-Length`；前提是导航请求的 `Accept-Encoding` 已摘除（压缩字节不可注入） |
| iOS「添加到主屏幕」后图标丢失 | iOS 抓图标/manifest 不带会话 Cookie，被 401 拦 | `/pwa/*` 白名单静态资产豁免认证（含路径穿越防护）；未来 `/pwa/push/*` 等动态端点必须另行鉴权，不能跟着豁免 |
| Android Chrome 没有「安装应用」入口 | Chrome 安装启发式硬条件：需互动并停留约 30s；厂商自带浏览器大多阉割 PWA 安装 | 用 Chrome/Edge 打开、点几下并停留后再装；无 Google Play 服务的 ROM 无法铸 WebAPK，退化为普通快捷方式（已知限制） |
| lan 模式 Android 无法完整安装 | HTTP 明文下浏览器不注册 Service Worker | 预期降级：Android 退化为浏览器快捷方式；iPhone 仍可「添加到主屏幕」成 web clip。完整 PWA 只在 HTTPS（frp/ssh）下可用 |
| cf 模式装的 PWA 重启后失效 | 临时域名每次启动更换，安装产物随旧 origin 作废 | 预期行为：cf 模式不建议安装，直接用浏览器标签页 |

## 6. 配置与状态

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| 改了 `frp/frpc.toml` 不生效 / 面板保存后丢字段 | frpc.toml 只是 `config.json` 全量重生成的产物 | `config.json` 是**唯一配置数据源**（frp 参数存 `config.json.frp`）；老安装由 `migrateFrpIntoConfig` 一处迁移；写文件必须走 `saveConfigAtomic`（临时文件 + rename） |
| 面板清空某字段保存，配置被写成空串 | 用 `??` 挡空串，把「用户没改」当成「改成空」 | 表单空串语义 = 「未改动」，用 `pick` 助手回退 existing |
| 面板保存瞬间团灭 / dsh 被重启 | 见 §3 热重启竞态；另：重启 dsh 会杀掉正在跑的 agent 会话 | **面板保存 = 只重启网关 + 隧道，dsh 不动**；gen 代际 + `waitExit` |
| 本机恶意网页静默改配置 / 读走登录链接 | localhost 上的 HTTP 服务对其他网页同源策略可达 | 面板只绑 127.0.0.1；所有 POST 必须带 `X-DG-Admin` 自定义头——跨站请求过不了 CORS 预检带不了自定义头（该防线勿删）；前端 CSP `default-src 'self'`，静态文件白名单闭集 |
| 面板里轮换令牌后把自己锁外面 | POST 响应只改了配置，没换面板自身的 Cookie | 令牌轮换的 POST 响应必须 `Set-Cookie` 换新 |

## 7. 开发环境

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| 测试探针读到的文件内容乱码 | PowerShell 5.1 `Get-Content -Raw` 以 GBK 解码 UTF-8 | 探针直接 pipe 给 node 读，不经 PowerShell 字符串 |
| dsh 升级后 `patch-dsh.mjs` 报错 | 补丁锚点（严格 LF + Tab）随上游代码漂移 | 设计如此：锚点缺失即 throw、不写半个补丁；按新源码重新对锚点 |
