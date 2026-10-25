> **已下线（2026-10-25）**：公网主控已拆除，本地 `data`/`bin`/`logs` 已清。代码仅存档；站点改回宝塔管理。

# Site Panel（Caddy 版）

集中管理约 30～50 台客户机上的静态站。主控保存原件，SSH 推到节点 **Caddy**。

**公网已切到本版**（2026-10-24）：`https://site-panel.xfnss.top`

旁路旧 Nginx 版目录：`../site-panel`（仅存档，勿再往公网主控装）。
公网旧库备份：`/var/lib/site-panel/backups/pre-caddy-cutover-*` 与 `pre-migrate-*`。

## 目标

- 节点装 Caddy，不装 Nginx/certbot
- UI 改常见项（域名 / 静态|反代 / SSL）；高级保留排查只读
- 自动 HTTPS 前硬卡公网 DNS + 外网 :80/:443；失败可强制但会提示
- 主控仍是唯一原件：SSH 推送 → `caddy reload`（Admin API 仅本机）

详见 [docs/10-caddy-plan.md](docs/10-caddy-plan.md)、[docs/08-master-deploy.md](docs/08-master-deploy.md)。

## 日常

1. 左栏加 IP → 安装 agent（干净机，无宝塔）→ 加站点
2. 右侧改配置包 / 文件 → **部署**
3. 停用/删除在左边操作远端；只有部署才推配置
4. Agent ≥ **0.3.1-caddy**

## 本机开发

```bash
./scripts/build.sh
# 本地主控（勿与生产 data 混用）
./bin/site-panel -data ./data -listen 127.0.0.1:8091 -web-dir ./web -node-binary ./bin/site-panel-node
```

更新公网：

```bash
./scripts/build.sh
./scripts/migrate-master.sh root@45.194.37.198
# 或只换二进制：SKIP 数据后 scp + systemctl restart
```
