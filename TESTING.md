# 手动端到端测试清单

> 本清单覆盖 **SSH 反向隧道**、**LAN 局域网直连** 与 **CF 临时隧道** 三种模式的真实环境验证（前两者已真机实测基本可用；cf 已实现待实测）。
> 纯逻辑已由自动化测试覆盖（`npm test`，当前 45 项）；本清单只列必须要有真实服务器 / 真机 / 真网络才能验的项，逐条打勾即可。

## 0. 基线（每次开始前）

- [x] `npm test` 全绿（45/45）
- [x] `git status` 干净，无 `config.json` / `frp/frpc.toml` / `.dsh-usage-stats.json` 泄漏

---

## 1. SSH 反向隧道模式

### 1.1 服务器侧前置（公网服务器，一次性配置）

- [x] sshd 已运行：`systemctl status sshd`（或 `service ssh status`）为 active
- [x] `AllowTcpForwarding yes`：`sshd -T | grep -i allowtcpforwarding` 输出 `yes`
- [x] 无需 `GatewayPorts`（反向隧道默认只绑 127.0.0.1，可确认其保持默认）
- [x] 目标账号存在且可登录
- [x] 本机公钥已加入该账号 `~/.ssh/authorized_keys`（内容 = 本机 `~/.ssh/id_ed25519.pub`；文件权限 600）
- [x] 反代已配：Nginx/Caddy 把域名 HTTPS 流量转到 `127.0.0.1:3088`，并带 `X-Forwarded-Proto: https`

### 1.2 本机侧前置

- [x] OpenSSH 客户端存在：`ssh -V`
- [x] 私钥存在：`~/.ssh/id_ed25519`（或你配置的路径）
- [x] 首次手动录入主机指纹：`ssh -i ~/.ssh/id_ed25519 <user>@<host>`，确认指纹后能登录
- [x] （连不上时排查：authorized_keys、服务器防火墙放行 22、sshd 端口）

### 1.3 配置

- [x] `npm start -- --setup`，选 `ssh`，填 host / port / user / keyPath / 域名
- [x] setup 自检打印「配置完成：隧道: ssh → user\@host:port」且未报错退出
- [x] `config.json` 出现 `mode:"ssh"` 与 `ssh:{host,port,user,keyPath}`；私钥本体不在仓库内（config 只存路径）

### 1.4 启动与访问

- [x] 启动日志出现 `[ssh]` 前缀，无 `[frpc]`
- [x] 手机（公网 / 移动数据）打开 `https://<域名>/?t=<token>` → 302 → 进入 DSH，可正常对话
- [x] Android 可安装为完整 PWA（HTTPS + Service Worker 生效）
- [x] iPhone「添加到主屏幕」成完整 PWA（HTTPS）

### 1.5 断线重连（关键行为）

- [x] 隧道正常时，本机 `taskkill /F /IM ssh.exe`（或服务器 `systemctl restart sshd`）
- [x] 日志出现「ssh 隧道断开 (code=…)」，约 3s 后自动重连成功，手机恢复访问
- [x] **其余进程不团灭**：`dsh` / `gate` 仍存活，只是短暂不可用后自愈
- [x] （可选）快速失败提示：把 `config.json` 的 `ssh.keyPath` 改为不存在路径后 `npm start`，ssh 立即失败重试，第 3 次出现「连续快速断开，疑似认证/主机指纹/网络问题」提示（仍持续重连、不团灭）

### 1.6 安全核对

- [x] 启动参数含 `StrictHostKeyChecking=yes`（不接受未知主机，防中间人）
- [x] 首次连未知主机时被拒（不会自动 `accept-new`）
- [x] `BatchMode=yes`：全程不弹密码交互框
- [x] 手机访问地址是 `https://`，登录 Cookie 带 `Secure`

---

## 2. LAN 局域网直连模式

### 2.1 启动与访问

- [ ] `npm start -- --mode lan` → `config.json` 出现 `mode:"lan"`
- [ ] 启动日志只有 `[dsh]` / `[gate]`，无 `[frpc]` / `[ssh]`
- [ ] 日志打印 `http://<局域网IP>:3088/?t=…`；确认 IP 是本机当前 Wi-Fi 网卡的地址（网关用默认路由探测选 IP，并在下方列出其余候选；挂了 VPN/虚拟网卡时对照 `ipconfig` 的 WLAN 项确认）
- [ ] 手机连**同一 Wi-Fi**，浏览器打开该链接 → 进入 DSH，可正常对话/操作
- [ ] 进页面后**选工作区、改设置**不报错（明文 HTTP 下浏览器无 `crypto.randomUUID`，网关已注入 polyfill；若仍报 `randomUUID is not a function` 说明注入失效，属 bug 需上报）

### 2.1a 打不开时的排查（按顺序）

- [ ] 电脑本机浏览器开 `http://<局域网IP>:3088/`（**用局域网 IP，不是 127.0.0.1**）：返回 401 登录页 = 网络通、问题在手机侧；超时 = 防火墙或绑定问题
- [ ] 手机 `ping`/浏览器访问电脑的局域网 IP 是否可达：校园网/企业 Wi-Fi 普遍开启 **AP 客户端隔离**，同网设备互不可达——属环境问题，非网关故障
- [ ] 隔离疑云用热点排除：手机开热点、电脑连热点，重启 `npm start`（换网后 IP 会变），用新打印的 IP 访问
- [ ] 仍不通：对照横幅候选 IP 列表逐个替换链接中的 IP 重试

### 2.2 防火墙

- [ ] 首次绑 0.0.0.0 时 Windows 弹防火墙提示 → 点「允许」，且只勾「专用网络」

### 2.3 PWA 降级（预期行为）

- [ ] Android Chrome 打开：是普通网页、无「安装应用」入口（HTTP 下 SW 不注册）
- [ ] iPhone「分享 → 添加到主屏幕」：出现带图标 web clip，能打开（web clip 走 HTTP 可用）

### 2.4 换网

- [ ] 电脑换 Wi-Fi / DHCP 换 IP 后重启 `npm start`，打印的新 IP 正确，手机照常访问（无需改任何配置）

---

## 3. CF 临时隧道模式（quick tunnel）

### 3.1 前置

- [ ] 已下载 cloudflared 放进 `cf/`（见 `cf/README.md`）；`cf/cloudflared.exe version` 能输出版本号
- [ ] 未下载时 `npm start -- --mode cf`：打印下载指引并以非零码退出，配置已写入

### 3.2 启动与访问

- [ ] `npm start -- --mode cf` → `config.json` 出现 `mode:"cf"`；日志出现 `[cf]` 前缀，无 `[frpc]`/`[ssh]`
- [ ] 数秒后 `[start]` 打印 `登录链接: https://<随机串>.trycloudflare.com/?t=…`，无 cloudflared 的边框刷屏
- [ ] 手机（移动数据）打开该链接 → 302 → 进入 DSH，可正常对话、流式输出正常
- [ ] 登录 Cookie 带 `Secure`（CF 恒定 HTTPS，网关强制，不依赖 X-Forwarded-Proto）

### 3.3 生命周期

- [ ] 关掉 cloudflared 进程（或拔网线致其退出）→ **团灭**：start.bat 整体退出，日志说明「重启后会分配新域名」
- [ ] 重启 `npm start`：分配到**新的**临时域名，旧链接确认失效
- [ ] （可选）长时间挂机观察：CF 偶发强制轮换长存活的 quick tunnel，表现为入口失效，重启即恢复

### 3.4 已知限制核对（预期行为，非 bug）

- [ ] 大陆→CF 链路延迟/稳定性记录（运营商 + 时段），与 frp 模式对比，决定去留
- [ ] `/compact` 超过 100 秒 → CF 返回 524（免费层硬限制，不可调）
- [ ] PWA 可安装但每次重启作废——不装，直接用标签页

---

## 4. 四模式切换回归

- [ ] lan → `npm start -- --mode ssh`：`config.json` 保留原 `ssh.*` / `domain`，直接可用，无需重填
- [ ] lan → `npm start -- --mode frp`：frpc 正常拉起，公网 PWA 恢复可安装
- [ ] 任意模式 → `npm start -- --mode cf`：写入 `mode:"cf"`，cloudflared 拉起并打印临时域名链接；切回 frp/ssh 后原配置无感恢复
- [ ] 老安装（无 `mode` 字段）直接 `npm start`：仍默认 frp，无感（向后兼容）
- [ ] `npm start -- --mode foo`：报「访问模式只能是 frp、ssh、lan 或 cf」并退出

---

## 5. 安全核对（跨模式）

- [ ] 单令牌四模式共用：同一 `?t=` 在 frp / ssh / lan / cf 下都能登录（`config.json` 里是同一个 token）
- [ ] lan：手机访问是 `http://`（地址栏无锁），登录 Cookie **不带** `Secure`（否则 HTTP 下登录态失效）
- [ ] frp / ssh / cf：登录 Cookie **带** `Secure`；`cleanHeaders` 仍抹掉 `X-Forwarded-*`（勿放宽）
- [ ] cf：登录链接不泄露给不可信方（临时域名不可猜测，但令牌是唯一正式认证；CF 边缘可见明文）
- [ ] `git status` 无敏感文件泄漏

---

## 6. 已知未覆盖项

- [x] ~~SSH 真实端到端~~ 已实测基本可用（稳定性略逊于 frp、流式输出略卡，属预期）；重连/断线细项仍可照 §1.5 过一遍
- [x] ~~LAN 真实端到端~~ 已实测可用（热点环境：进页面、选工作区、改设置均正常）。校园网不可用系 AP 客户端隔离，属环境限制，不算缺陷；换网络环境后可照 §2 复验
- [ ] CF 临时隧道真实端到端（已实现，待真机实测；重点记录大陆链路质量，据此决定 cf 是否替代 frp）
- [ ] 任务完成 Web Push（v2，已明确推迟）

