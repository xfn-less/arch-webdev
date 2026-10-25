# 08 主控部署（Debian 12 · 公网反代）

目标：买好的 **Debian 12 / 4C4G** 公网机器，尽量省事跑主控；面板不直接裸奔，前面 HTTPS 反代。

## 1. 机器角色

- 只跑面板 + 存原件 + SSH 推节点
- **不**给客户站做业务流量
- 4C4G 远超面板需求；磁盘按站点原件预留（建议至少留最大包的 2 倍临时空间）

## 2. 最小安装步骤

仓库已带固定安装脚本与单元（不必做成节点 agent）：

```sh
./scripts/build.sh
sudo ./scripts/install-master.sh
# 反代示例：deploy/nginx-panel.conf.example
# 单元：deploy/site-panel.service
```

或手工：

在构建机（或本机）交叉/同构编好后拷到主控：

```sh
# 构建机
cd site-panel && ./scripts/build.sh
scp bin/site-panel root@主控:/usr/local/bin/site-panel
```

主控：

```sh
useradd --system --home /var/lib/site-panel --shell /usr/sbin/nologin site-panel || true
mkdir -p /var/lib/site-panel/data
chown -R site-panel:site-panel /var/lib/site-panel
chmod 700 /var/lib/site-panel /var/lib/site-panel/data
```

systemd 单元示例 `/etc/systemd/system/site-panel.service`：

```ini
[Unit]
Description=Site Panel master
After=network.target

[Service]
Type=simple
User=site-panel
Group=site-panel
WorkingDirectory=/var/lib/site-panel
ExecStart=/usr/local/bin/site-panel -listen 127.0.0.1:8090 -data /var/lib/site-panel/data -secure-cookie
Restart=on-failure
UMask=0077

# 若用本机 SSH 私钥推节点，取消下一行并改路径/权限（私钥对 site-panel 可读）
# 或在 ExecStart 加：-ssh-key /var/lib/site-panel/id_ed25519

[Install]
WantedBy=multi-user.target
```

> 节点推送私钥默认 `/var/lib/site-panel/id_ed25519`，公钥需写入各客户节点 `authorized_keys`。启动参数以当前 `cmd/panel` 实际 flag 为准；落地时对照 `site-panel -h` 微调（`-listen` / `-data` / `-secure-cookie` / `-ssh-key` / `-key-file`）。公网反代必须 `-secure-cookie`。

```sh
systemctl daemon-reload
systemctl enable --now site-panel
```

确认只听本地：

```sh
ss -lntp | grep 8090   # 应为 127.0.0.1:8090
```

## 3. Nginx 反代（推荐）

面板域名例如 `panel.example.com`，证书可用 certbot（主控自己的站，和节点站点无关）。

```nginx
server {
    listen 80;
    server_name panel.example.com;
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    client_max_body_size 512m;   # 按最大 APK/压缩包调整

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

防火墙只开 22/80/443；**不要**对公网开 8090。

## 4. 出网要求

- SSH 到所有客户节点
- 公网 DNS/DoH（部署前解析检查）
- 若节点用密码：主控 AEAD 密钥在 `data/master.key`；若用密钥：放好私钥权限


## 5b. 从本机迁移数据到公网主控

空面板不要手搓重加站点。用固定脚本把本机 `data/`（含 **`master.key`**）迁过去，并保留**服务器自己的**推送钥：

```sh
./scripts/build.sh
./scripts/migrate-master.sh root@主控IP
# 例：./scripts/migrate-master.sh root@45.194.37.198
```

脚本会：

1. `sqlite3 .backup` 做一致快照（含 sites / nginx-configs / 证书库等）
2. 远端先备份到 `/var/lib/site-panel/backups/pre-migrate-...`
3. 替换 `/var/lib/site-panel/data/`（**必须**连同 `master.key`，否则节点密码密文解不开）
4. **不**用笔记本私钥覆盖主控；主控继续用 `/var/lib/site-panel/id_ed25519`
5. 用你当前能登上节点的钥匙，把主控公钥写入各节点 `authorized_keys`，再从主控反查 SSH

登录密码 = 本机原面板账号密码。个别节点笔记本钥匙登不上时，脚本会告警并 exit 2，数据迁移本身已完成；把主控公钥手工补上即可。



## 5c. R2 定时备份（meta 勤 / sites 疏 · 无改动跳过）

目标：配置类常备、站点原件少备；没改动就跳过上传；换机用最新包恢复。

### 免费够不够

Cloudflare R2 免费档对当前体量够用（整包仍是 MB～小 GB 级）。出站流量 R2 不按常规 S3 计，换机拉包也省心。站点原件变大后再看是否收紧频率。

### 包种类

| KIND | 内容 | 建议频率 |
|---|---|---|
| `meta` | `panel.db`、`master.key`、`nginx-configs/`、`deploy-snapshots/`、`id_ed25519` | 每小时（无改动跳过）；小时留 12 |
| `sites` | 按站 `data/sites/<id>/` | 每天，仅改动站上传；日留 3 |
| `full` | meta+sites（可选 tasks） | 手动/应急 |

指纹相同则 `skip …: unchanged`；`FORCE=1` 可强制打一份。不设周强制；站点按站打包，只上传有改动的站。

### 一次性配置（主控）

```sh
# 1) 工具
apt-get update && apt-get install -y rclone
# age: https://github.com/FiloSottile/age/releases 或发行版包

# 2) age 密钥（私钥只放主控 + 你的密码管理器另存一份）
mkdir -p /etc/site-panel
age-keygen -o /etc/site-panel/age.key
chmod 600 /etc/site-panel/age.key
age-keygen -y /etc/site-panel/age.key   # 得到 AGE_RECIPIENT

# 3) rclone → Cloudflare R2
rclone config
# name: r2 / type: s3 / provider: Cloudflare
# access_key_id / secret_access_key 用 R2 API Token
# endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
rclone mkdir r2:site-panel

# 4) 环境与脚本
cp deploy/backup.env.example /etc/site-panel/backup.env
# 填 AGE_RECIPIENT 与 RCLONE_REMOTE=r2:site-panel
chmod 600 /etc/site-panel/backup.env
install -m 755 scripts/backup-master.sh /usr/local/libexec/site-panel-backup
install -m 755 scripts/restore-master.sh /usr/local/libexec/site-panel-restore
cp deploy/site-panel-backup.cron /etc/cron.d/site-panel-backup
chmod 644 /etc/cron.d/site-panel-backup

# 5) 冒烟
KIND=meta /usr/local/libexec/site-panel-backup
KIND=meta /usr/local/libexec/site-panel-backup   # 应 skip unchanged
KIND=sites /usr/local/libexec/site-panel-backup
```

本地不传 R2 试打包：

```sh
AGE_RECIPIENT=age1... LOCAL_ONLY=1 KIND=meta ./scripts/backup-master.sh
LOCAL_ONLY=1 KIND=meta ./scripts/backup-master.sh   # skip
FORCE=1 LOCAL_ONLY=1 KIND=meta ./scripts/backup-master.sh
```

### 换机恢复

```sh
sudo ./scripts/install-master.sh
# 配好 /etc/site-panel/backup.env 与 age 私钥、rclone
/usr/local/libexec/site-panel-restore
# 默认拉 meta/latest + sites/latest，拼回 data/，检查站点目录覆盖
```

也可用本机迁库：`./scripts/migrate-master.sh root@新主控`（源是旧机 data，不是 R2）。

## 5d. Telegram 总览

用 **专用新 bot**（勿与 todolist 等抢收消息）。面板顶栏「TG 总览」保存 Token（加密）与工作群 Chat ID。

- **自动**：每天 **06:00 / 18:00（Asia/Shanghai）** 全检所有节点后汇报；发出后删除上一份，群里只留最新。
- **手动**：同一入口「立刻推送」，同样会替换旧汇报。
- 消息含节点 IP、备注、SSH、Nginx/agent、站点域名与启用/停用，方便群内搜域名反查。

## 5. 备份（必做）

停服务或用一致快照，至少拷贝：

- `/var/lib/site-panel/data/`（含 `panel.db`、`sites/`、`nginx-configs/`、任务）
- **`master.key`**（可在 data 内；丢失则节点密码密文与证书备份无法解密）

恢复：同路径放回 → 启服务。不要只在线 `cp` 正在写入的 SQLite 主文件当完整备份。

## 6. 省事检查清单

1. `systemctl status site-panel` 正常
2. `curl -sI https://panel.example.com` 200/302
3. 登录设密（首次）
4. 加一台测试节点 → 安装 → 部署一条站
5. 确认 8090 公网扫不到

## 7. 和节点的区别

| | 主控 | 节点 |
|---|---|---|
| 系统 | Debian 12（本方案） | 能力探测通过的 Debian/Ubuntu |
| 公网 | HTTPS 反代面板 | 客户站 80/443 |
| 磁盘 | 原件 + 证书备份 | 运行副本 + live 证书 |
