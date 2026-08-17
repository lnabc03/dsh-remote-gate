# cf/ — cloudflared 二进制放置目录

cf 模式（Cloudflare quick tunnel）需要官方 `cloudflared` 客户端，与 `frp/frpc` 一样是外部二进制，不进仓库（已 gitignore）。

## 下载

<https://github.com/cloudflare/cloudflared/releases>（取最新版即可）

| 平台 | 下载文件 | 放到这里并改名为 |
| --- | --- | --- |
| Windows x64 | `cloudflared-windows-amd64.exe` | `cf/cloudflared.exe` |
| macOS（Apple Silicon） | `cloudflared-darwin-arm64.tgz` 解压 | `cf/cloudflared` |
| macOS（Intel） | `cloudflared-darwin-amd64.tgz` 解压 | `cf/cloudflared` |
| Linux x64 | `cloudflared-linux-amd64` | `cf/cloudflared` |

GitHub 直连慢时可走镜像（如 `https://ghproxy.net/https://github.com/...` 前缀）。

## 说明

- 无需 Cloudflare 账号、无需域名、无需任何凭证文件——quick tunnel 每次启动分配 `*.trycloudflare.com` 临时域名，进程退出即销毁
- 启动命令由 `start.mjs` 固定为 `cloudflared --no-autoupdate tunnel --url http://127.0.0.1:3088`
- cloudflared 进程退出 = 临时域名失效 = 整体退出（团灭），重启后分配新域名，需把新的登录链接重新发到手机
