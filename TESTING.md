# 手动端到端测试清单

> 本清单覆盖两种**已实现但未真实端到端实测**的模式：**SSH 反向隧道** 与 **LAN 局域网直连**。
> 纯逻辑已由自动化测试覆盖（`npm test`，当前 35 项）；本清单只列必须要有真实服务器 / 真机 / 真网络才能验的项，逐条打勾即可。

## 0. 基线（每次开始前）

- [ ] `npm test` 全绿（35/35）
- [ ] `git status` 干净，无 `config.json` / `frp/frpc.toml` / `.dsh-usage-stats.json` 泄漏

---

## 1. SSH 反向隧道模式

### 1.1 服务器侧前置（公网服务器，一次性配置）

- [ ] sshd 已运行：`systemctl status sshd`（或 `service ssh status`）为 active
- [ ] `AllowTcpForwarding yes`：`sshd -T | grep -i allowtcpforwarding` 输出 `yes`
- [ ] 无需 `GatewayPorts`（反向隧道默认只绑 127.0.0.1，可确认其保持默认）
- [ ] 目标账号存在且可登录
- [ ] 本机公钥已加入该账号 `~/.ssh/authorized_keys`（内容 = 本机 `~/.ssh/id_ed25519.pub`；文件权限 600）
- [ ] 反代已配：Nginx/Caddy 把域名 HTTPS 流量转到 `127.0.0.1:3088`，并带 `X-Forwarded-Proto: https`

### 1.2 本机侧前置

- [ ] OpenSSH 客户端存在：`ssh -V`
- [ ] 私钥存在：`~/.ssh/id_ed25519`（或你配置的路径）
- [ ] 首次手动录入主机指纹：`ssh -i ~/.ssh/id_ed25519 <user>@<host>`，确认指纹后能登录
- [ ] （连不上时排查：authorized_keys、服务器防火墙放行 22、sshd 端口）

### 1.3 配置

- [ ] `npm start -- --setup`，选 `ssh`，填 host / port / user / keyPath / 域名
- [ ] setup 自检打印「配置完成：隧道: ssh → user@host:port」且未报错退出
- [ ] `config.json` 出现 `mode:"ssh"` 与 `ssh:{host,port,user,keyPath}`；私钥本体不在仓库内（config 只存路径）

### 1.4 启动与访问

- [ ] 启动日志出现 `[ssh]` 前缀，无 `[frpc]`
- [ ] 手机（公网 / 移动数据）打开 `https://<域名>/?t=<token>` → 302 → 进入 DSH，可正常对话
- [ ] Android 可安装为完整 PWA（HTTPS + Service Worker 生效）
- [ ] iPhone「添加到主屏幕」成完整 PWA（HTTPS）

### 1.5 断线重连（关键行为）

- [ ] 隧道正常时，本机 `taskkill /F /IM ssh.exe`（或服务器 `systemctl restart sshd`）
- [ ] 日志出现「ssh 隧道断开 (code=…)」，约 3s 后自动重连成功，手机恢复访问
- [ ] **其余进程不团灭**：`dsh` / `gate` 仍存活，只是短暂不可用后自愈
- [ ] （可选）快速失败提示：把 `config.json` 的 `ssh.keyPath` 改为不存在路径后 `npm start`，ssh 立即失败重试，第 3 次出现「连续快速断开，疑似认证/主机指纹/网络问题」提示（仍持续重连、不团灭）

### 1.6 安全核对

- [ ] 启动参数含 `StrictHostKeyChecking=yes`（不接受未知主机，防中间人）
- [ ] 首次连未知主机时被拒（不会自动 `accept-new`）
- [ ] `BatchMode=yes`：全程不弹密码交互框
- [ ] 手机访问地址是 `https://`，登录 Cookie 带 `Secure`

---

## 2. LAN 局域网直连模式

### 2.1 启动与访问

- [ ] `npm start -- --mode lan` → `config.json` 出现 `mode:"lan"`
- [ ] 启动日志只有 `[dsh]` / `[gate]`，无 `[frpc]` / `[ssh]`
- [ ] 日志打印 `http://<局域网IP>:3088/?t=…`；确认 IP 是本机真实局域网 IP（挂 VPN/虚拟网卡时确认没选错网卡）
- [ ] 手机连**同一 Wi-Fi**，浏览器打开该链接 → 进入 DSH，可正常对话/操作

### 2.2 防火墙

- [ ] 首次绑 0.0.0.0 时 Windows 弹防火墙提示 → 点「允许」，且只勾「专用网络」

### 2.3 PWA 降级（预期行为）

- [ ] Android Chrome 打开：是普通网页、无「安装应用」入口（HTTP 下 SW 不注册）
- [ ] iPhone「分享 → 添加到主屏幕」：出现带图标 web clip，能打开（web clip 走 HTTP 可用）

### 2.4 换网

- [ ] 电脑换 Wi-Fi / DHCP 换 IP 后重启 `npm start`，打印的新 IP 正确，手机照常访问（无需改任何配置）

---

## 3. 三模式切换回归

- [ ] lan → `npm start -- --mode ssh`：`config.json` 保留原 `ssh.*` / `domain`，直接可用，无需重填
- [ ] lan → `npm start -- --mode frp`：frpc 正常拉起，公网 PWA 恢复可安装
- [ ] 老安装（无 `mode` 字段）直接 `npm start`：仍默认 frp，无感（向后兼容）
- [ ] `npm start -- --mode foo`：报「访问模式只能是 frp、ssh 或 lan」并退出

---

## 4. 安全核对（跨模式）

- [ ] 单令牌三模式共用：同一 `?t=` 在 frp / ssh / lan 下都能登录（`config.json` 里是同一个 token）
- [ ] lan：手机访问是 `http://`（地址栏无锁），登录 Cookie **不带** `Secure`（否则 HTTP 下登录态失效）
- [ ] frp / ssh：登录 Cookie **带** `Secure`；`cleanHeaders` 仍抹掉 `X-Forwarded-*`（勿放宽）
- [ ] `git status` 无敏感文件泄漏

---

## 5. 已知未覆盖项

- [ ] SSH 真实端到端：服务器 sshd + `authorized_keys` + known_hosts + 反代全链路（尚未实测）
- [ ] LAN 真实端到端：不同网段手机连 `0.0.0.0` + 防火墙放行（尚未实测）
- [ ] 任务完成 Web Push（v2，已明确推迟）
