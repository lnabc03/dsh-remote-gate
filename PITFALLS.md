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
| 半天跑了近 1G 隧道流量 | 早期为注入 HTML 全量摘除 `Accept-Encoding`，导致 JS bundle 未压缩过隧道 | `Accept-Encoding` **只在导航请求**（Accept 含 text/html）摘除。**dsh 0.2 起上游自己就带 gzip**（`compression: gzip, level 1, 阈值 1KB`），网关出站 gzip 因此几乎只剩兜底作用（上游已压缩即自动让路，实测同一 bundle 直连/过网关都是 237502 B，无二次压缩）。代码与豁免仍勿删：dsh 改压缩策略时会立刻退化，且导航摘 `Accept-Encoding` 是 HTML 注入的前提 |
| 手机弱网断帧修复一次拉几百 KB | dsh 断帧修复原实现「整页重拉 `session.history` + 整窗替换」：一页 50 条消息 4.7MB raw / 541KB gz | 0.1.x 时代靠 `patch-dsh.mjs`（**已删除**）改 `repairTailMerge` 增量合并。**dsh 0.2 该补丁失效，而问题更严重**：新版 `dsh-api-session-controller/lib/client.js` 的 `HISTORY_PAGE_OPTIONS` 是 `{maxMessages:500, turnWindow:{minMessages:50,minTurns:2}}`，重连与断帧修复仍整页重拉并整窗替换，实测单个会话重连可拉 ~1.1MB raw（撞 500 上限时可达 ~11MB raw，gzip 约 1/8）。要修需直接改那个常量（最省事）或动 `dsh-api-gateway/lib/client.js` 的 `RemoteJournalStream` 做真正的增量合并 |
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
| 程序已经退出了，面板 `--app` 窗口却还挂在桌面上（指向死服务，空白） | 三个原因叠在一起：① `shutdown()` 里 `killPanelBrowser()` 是 fire-and-forget，却在 500ms 后就 `process.exit`，而关窗要起 PowerShell + 1.5s 宽限（≈2s）→ 每次都被自己掐死，窗口永远关不掉；② 同类关停还**先把看门狗杀了**，安全网也没了；③ 撞端口（EADDRINUSE）的实例会先把面板窗口弹出来，紧接着团灭，于是留下一个指向死服务的空白 `--app` 窗口 | 三处一起修：`shutdown()` **await** 关窗（上限 5s，兜底 6s）且看门狗留到最后杀；`main()` 里开窗前先等 1.2s 让「端口被占」这类秒失败先暴露，`shuttingDown` 就不开窗；`killPanelBrowser` 增加不依赖 WMI 的按 pid 通道（见下方 `killPanelBrowser` 那条）。另：`shutdown` 只关**本进程记录过的**那个 pid，避免误杀另一个实例的面板窗口 |
| 桌面上多出一个「不明窗口」：**不在任务栏**、暗色背景、没有内容、没有操作按钮，关掉控制台后约 1 秒它自己消失 | 两个 bug 叠出来的：① **`spawn(edge, …, { windowsHide: true })`**——那是给控制台程序的开关，对 GUI 的 Edge 等于让首个窗口以 `SW_HIDE` 启动，实测 `--app` 主窗口会一直 `IsWindowVisible=false`，**面板界面根本不显示**；② 面板用的是隔离 profile，但 Edge 会顺着 Windows 账户 SSO 自动登录，于是在 app 窗口上挂一个「我们正在你的所有设备上同步你的浏览数据」通知弹窗（`Chrome_WidgetWin_1`、524×364、**无标题**、`WS_POPUP`、**owner = app 窗口**）。有 owner 的窗口不进任务栏，且 owner 销毁时它被一起销毁——而 owner（面板浏览器）正是看门狗在控制台死后约 1s 关掉的。于是用户看到的就是「一个不属于任何程序的暗色空窗口，关掉控制台它自己就没了」。截图里它的文字右侧还被截断、"明白"按钮压在边角，更像"没有操作键" | ① **浏览器 spawn 绝不能带 `windowsHide`**（`detached: true, stdio: 'ignore'` 即可）；② 加上 `--disable-sync --no-service-autorun` 压掉同步通知。实测修复后该 pid 只剩一个 `vis=True 1440×860` 的面板主窗口。排查手法：`EnumWindows` + `GetWindow(GW_OWNER)` + `GWL_EXSTYLE` 找 owner 链（`PrintWindow(hwnd, hdc, 2)` 可以把窗口截图存证；注意它对 D3D 合成层会拍成空白，别据此判断页面没渲染） |
| 面板窗口关不掉，且 `killPanelBrowser` 一声不响什么都没做 | 它只有「按命令行枚举」一条通道，用 `Get-CimInstance Win32_Process`。本机实测 WMI 会整片报错（HRESULT `0x80004005`，连试 8 次全失败）；查询抛错被 `catch` 吞掉 → `$procs` 为空 → 不杀也不报错。同一时间 `Get-NetTCPConnection`（背后也是 CIM）会**静默返回空**，让人误判「端口没被占」——排查时务必用原生 `netstat -ano` / `tasklist` 复核 | `killPanelBrowser` 增加 pid 通道：`openInBrowser` 拉起面板窗口后把浏览器主进程 pid 写到 `panel-profile` 的兄弟文件 `panel-browser.pid`，关窗时先按它 `CloseMainWindow` + 宽限 + `process.kill`（完全不碰 WMI），再退回命令行扫。写 pid 前先等 1.5s 确认进程还活着——若已退出说明 Edge 把命令交给了同 profile 的既有实例，此时**不能**覆盖旧记录 |
| 双击 `start.bat` 后「莫名多出一个窗口」，任务栏里写着 **Windows PowerShell**，认不出是哪个程序 | `start "dsh-remote-gate" /min powershell ...` 里的 `"dsh-remote-gate"` 是 **cmd `start` 的窗口标题参数**，但 PowerShell 启动时会把控制台标题改成「Windows PowerShell」，把它覆盖掉；窗口本身还按设计**最小化**在任务栏（用来放日志 + 按回车重开面板），于是只剩一个看不懂名字的最小化图标 | `start.mjs` 的 `main()` 里设 `process.title = 'dsh-remote-gate'`——node 与 PowerShell 共用一个控制台，等价于 SetConsoleTitle，实测任务栏标题立刻变成 `dsh-remote-gate`。只在 main 里设（测试会 import 本模块，别去改别人控制台的标题） |
| 关掉面板窗口后程序「还在跑」，再双击 `start.bat` 就失败，日志一屏 `EADDRINUSE` 堆栈 | 面板窗口关闭**不等于**退出（控制台才是生命周期所有者）；残留的 gateway 一直占着 3088，新实例的网关绑定失败 → 被当成「意外崩溃」→ 团灭 | ① `gateway.mjs` 捕获 `EADDRINUSE`：打印三行可照做的提示（`netstat -ano \| findstr :3088` → `taskkill /PID … /T /F`）并用**退出码 2** 退出；② `start.mjs` 见 code 2 时改说「端口被占用，已停止全部进程」而不是笼统的团灭 |

## 4. 拓扑与网络

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| （设计前提）经 frp/ssh 后所有请求的 `remoteAddress` 都是 127.0.0.1 | 隧道在本机回灌 | **绝不引入任何基于 IP 的逻辑**：IP 审批/限流/「本机」栅栏在此拓扑下失效且有安全反效果（远端用户被误判为本机）。认证只有令牌 + HttpOnly Cookie；防爆破用全局失败计数（30 次/分钟），不按 IP |
| dsh 敏感 API（工作区/设置/凭证）被拦 | dsh 有本机风控，要求请求来自本机 | 网关转发必须与本机浏览器访问**不可区分**：`Host` 重写为 `127.0.0.1:3080`；`Origin` 重写为 `http://127.0.0.1:3080`（仅原请求带 Origin 时）；丢弃 `Referer`/`X-Forwarded-*`/`X-Real-IP`/`Forwarded`；网关自身的 `dg_token` Cookie 不上行 |
| 远程经网关用 dshmarket 安装/更新插件报 `更新失败: … — untrusted origin`，本机正常 | dshmarket 所有变更类 POST 做 same-origin 校验：**Origin 头必须存在且与 Host 一致**；网关原先把 Origin 整个丢弃，缺 Origin 直接判 403 | `Origin` 由「丢弃」改为「重写为本机源」——本机浏览器发 POST 本来就带 `Origin: http://127.0.0.1:3080`，重写后才算真正「不可区分」；dsh 核心的 `isTrustedApiRequest` 同样只比 host 部分，重写后照样通过 |
| 升级到 dsh ≥ 0.2 后，手机打开网关**全站 401**（页面就一行 `dsh web authentication required; reopen the URL printed by dsh web.`），本机 `http://127.0.0.1:3080` 也一样 | dsh 0.2 给 `dsh web` 加了**自己的浏览器会话认证**：`GET /` 与所有 `/api` 都要求 `dsh-auth-*` 签名 Cookie，该 Cookie 只能拿一次性的 `?token=<启动令牌>`（启动时打印在 `dsh web:` 那行）访问根路径换取，且受众绑定在请求 Host 的 authority 上。「Host 改写成 127.0.0.1:3080 就等价于本机浏览器」的前提不再成立——本机浏览器同样要出示 Cookie | 网关桥接：`start.mjs` 从 dsh stdout 抓启动令牌写 `.dsh-web-token`（已 gitignore，dsh 每次启动重写），`gateway.mjs` 按 mtime 懒读；导航请求被上游 401 时 302 到 `/?token=<令牌>`，dsh 种好 Cookie 后 303 回应用。因为 Host 被**固定**重写成同一个 authority，Cookie 名/受众对所有设备与隧道模式都一致，且签名密钥持久化在 dsh credentials 里 → 一次登录可跨 dsh 重启、默认 30 天有效。三个禁区：别对 `/api` 的 401 做重定向（前端要状态码）；串里已有 `token=` 时不再重定向（防环）；外部已运行的 dsh 抓不到令牌，只能 `DSH_GATE_DSH_TOKEN` 手动给 |
| dsh 0.2 起 `/api/commands/execute` 404，drip 保活永不触发 | dsh 0.2 把 API 改成插件注册的 `/api/<endpoint>` RPC + `/api/remote.mux` WS 通道，旧的同步长命令端点没了 | 网关的 drip 代码目前是**死代码**（不报错、只是不再命中）。新架构下长命令走 WS 流，是否仍需 drip 取决于真机实测是否还遇 504；在定位到新的同步长命令通道前先保留代码，别按「无引用」删掉 |
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
| 换了服务器，`config.json` 里地址/token 都核对过没问题（与服务器完全一致），frpc 却仍报 `token in login doesn't match` | **数据源对了，产物是陈旧的**：`frp/frpc.toml` 原来只在**面板保存**时才由 `config.json` 重生成；直接改 `config.json` 后它不会跟，frpc 读的仍是旧地址 → 拿新 token 去敲旧 frps → 必然不匹配。更糟的是 frpc 一死就团灭，面板来不及打开，于是被锁死在「改了没生效、面板又进不去」 | 新增 `syncFrpcToml()` 并在**每次启动**调用（内容没变就不写盘）：config.json 是唯一数据源，产物必须每次启动都对齐它。排查口诀：**`config.json` 和 `frp/frpc.toml` 的 `serverAddr`/`serverPort`/`auth.token` 三处必须一致**；怀疑时直接拿 token 分别探新旧服务器——哪台回 `login to server success` 就说明地址该指哪台 |
| 改服务器后双击 `start.bat`，窗口闪一下就没了（闪退），控制台里什么都没留下 | `frpc` 登录被拒后**立即退出**（新版 frp 默认 `loginFailExit`，不重试）：`token in login doesn't match token from configuration`。而按设计「frpc 退出 = 团灭」，整栈连控制台一起关掉，于是只剩「闪退」 | 先修配置（见上一行）。再修可见性：隧道致命退出时把**最近 20 行**（剥掉 ANSI 色码）落进 `start-crash.log`，并在日志里直接打一句中文「frp token 与服务器不一致…」；非零退出且处于 TTY 时控制台**多留 60 秒**（回车或超时即退），不再一闪而过 |
| 改了 `frp/frpc.toml` 不生效 / 面板保存后丢字段 | frpc.toml 只是 `config.json` 全量重生成的产物 | `config.json` 是**唯一配置数据源**（frp 参数存 `config.json.frp`）；老安装由 `migrateFrpIntoConfig` 一处迁移；写文件必须走 `saveConfigAtomic`（临时文件 + rename） |
| 面板清空某字段保存，配置被写成空串 | 用 `??` 挡空串，把「用户没改」当成「改成空」 | 表单空串语义 = 「未改动」，用 `pick` 助手回退 existing |
| 面板保存瞬间团灭 / dsh 被重启 | 见 §3 热重启竞态；另：重启 dsh 会杀掉正在跑的 agent 会话 | **面板保存 = 只重启网关 + 隧道，dsh 不动**；gen 代际 + `waitExit` |
| 本机恶意网页静默改配置 / 读走登录链接 | localhost 上的 HTTP 服务对其他网页同源策略可达 | 面板只绑 127.0.0.1；所有 POST 必须带 `X-DG-Admin` 自定义头——跨站请求过不了 CORS 预检带不了自定义头（该防线勿删）；前端 CSP `default-src 'self'`，静态文件白名单闭集 |
| 面板里点「打开 DSH 页面」，新标签页只有一行 `dsh web authentication required`（HTTP 401） | 按钮里硬编码了 `http://127.0.0.1:3080`。dsh 0.2 起 `/` 也要 dsh-auth-* 会话（约束 12），裸地址必然 401——**本机浏览器也不例外** | 「打开 DSH 页面」的地址改由 `/api/status` 下发（`dshUrl`），带上一次性启动令牌 `http://127.0.0.1:3080/?token=…`，dsh 会种好 Cookie 再 303 回干净 URL。令牌取 `state.dshToken` 或 `.dsh-web-token`；**外部已运行的 dsh 抓不到令牌，只能给裸地址（会 401）**——这也是「让 start.mjs 管 dsh」的又一个理由 |
| 面板里轮换令牌后把自己锁外面 | POST 响应只改了配置，没换面板自身的 Cookie | 令牌轮换的 POST 响应必须 `Set-Cookie` 换新 |

## 7. 开发环境

| 现象 | 根因 | 修复 / 现状 |
| --- | --- | --- |
| 测试探针读到的文件内容乱码 | PowerShell 5.1 `Get-Content -Raw` 以 GBK 解码 UTF-8 | 探针直接 pipe 给 node 读，不经 PowerShell 字符串 |
