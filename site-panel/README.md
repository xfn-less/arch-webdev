> **已下线（2026-10-25）**：公网主控已拆除，本地 `data`/`bin`/`logs` 已清。代码仅存档；站点改回宝塔管理。

# Site Panel

集中管理约 30～50 台客户机上的静态站 / APK 下载站。主控保存原件，SSH 推到节点 Nginx。

**当前阶段版本可用**：部署、SSL、停用/换绑、R2 备份、Telegram 总览。

- 面板：`https://site-panel.xfnss.top`（公网） / `http://127.0.0.1:8090`（本机）
- 栈：Go `net/http` + SQLite + VanJS（无前端构建）+ Ace + Lucide
- Agent ≥ **0.2.8**

## 日常

1. 左栏加 IP 节点 → 安装 agent → 加站点  
2. 传文件 / 改 Nginx / 变量 → **部署**  
3. 申请证书 → 改 DNS 指向节点 IP  
4. 客户群问域名时：工作群搜域名 → 看 TG 总览（早晚自动，也可手动）里的 IP → 上面板操作  

## 本机开发

```sh
./scripts/build.sh
./bin/site-panel -ssh-key "$HOME/.ssh/id_ed25519" -web-dir ./web
```

## 文档（精简入口）

| 文档 | 内容 |
|---|---|
| [05-status.md](docs/05-status.md) | **本阶段现状与用法** |
| [08-master-deploy.md](docs/08-master-deploy.md) | 主控安装 / 迁移 / R2 备份 |
| [06-ssl-and-layout.md](docs/06-ssl-and-layout.md) | SSL 与 `panel.inc` |
| [07-next-work.md](docs/07-next-work.md) | 后续可选 |
| [09-litessl-spike.md](docs/09-litessl-spike.md) | LiteSSL 暂不接 |

更早的 01–04 为设计底稿，以 05/08 为准。

## 不做（本阶段）

多人只读、路径改站点名、自动改 DNS/防火墙、真增量推送、LiteSSL、通配符 DNS-01、完整历史版本。
