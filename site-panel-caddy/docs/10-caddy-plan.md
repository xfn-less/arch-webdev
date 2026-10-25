# 10 Caddy 实验版计划

副本目录：`/home/xfn/arch-webdev/site-panel-caddy`  
对照原版：`/home/xfn/arch-webdev/site-panel`（Nginx + certbot）

## 目标

先做出可感效果，再对照「是否真省心」。

- 节点装 **Caddy**，不装 Nginx/certbot
- 站点意图：`静态 | 反代` + `证书：自动 | 关闭 | 自备`
- 常见项 UI 可改；**手改 Caddyfile 片段保留**
- 自动 HTTPS **先过公网 DNS**，失败即停，不狂重试 CA
- 主控仍是唯一原件；SSH 推送 + `caddy reload`（Admin API 仅本机，不当远程控制面）

## 节点路径（本实验）

| 项 | 路径 |
|---|---|
| 标记 | `/var/lib/site-panel/owned` → `site-panel-caddy-v1` |
| 站点文件 | `/srv/site-panel/sites/<id>/current` |
| 主 Caddyfile | `/etc/caddy/Caddyfile`（import sites） |
| 站点片段 | `/etc/caddy/sites/site-panel-<id>.caddy` |
| 执行器 | `/usr/local/libexec/site-panel-node` |

与 Nginx 版**不要装在同一台对比机上**（路径重叠）。对照请用另一台节点或先清干净。

## 站点模型

```
domains[]     # 地址列表：域名 / *.域名 / IP / IP:端口
mode: static | proxy
upstreams[]   # proxy 时；复杂项可手改 Caddyfile
cert: auto | off | custom
port          # 由列表推导（兼容旧站）
enabled
```

UI / 操作流程：
1. 加 IP 节点 → 安装 agent
2. 加站 → 域名页填地址列表（域名 / IP:端口）
3. 同页选静态或反代，填上游
4. 变量 → 上传文件 → 部署 → 看日志 → 访问验证
5. 自动 HTTPS 时：域名 HTTP→HTTPS（可关）；IP:端口始终仍可 HTTP 访问

生成示例：

```caddyfile
# Managed by site-panel-caddy
example.com {
	root * /srv/site-panel/sites/<id>/current
	file_server
	encode gzip
}
```

反代：

```caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

停用：

```caddyfile
# site-panel-disabled-stub
example.com {
	respond "site disabled" 503
}
```

## SSL / HTTPS（界面原则）

**没有「勾几个域名申请 SSL」。**

正确流程：
1. 建站时选证书模式（默认自动 HTTPS）
2. 「域名&HTTPS」页管理域名列表 + 证书模式
3. DNS 对准后点**部署** → Caddy 对**当前全部域名**自动申请/续期

| 模式 | 行为 |
|---|---|
| auto | DNS 必须指向节点；部署后由 Caddy 申请/续期（全量域名） |
| off | `http://` 站点块，适合 IP / 测试端口；部署不硬卡 DNS |
| custom | 自备商业证书（后置，一个客户） |

单独 `POST /ssl` 会返回明确错误，引导走部署。

## 对照清单（用一段时间后填）

- [ ] 装环境是否比 Nginx+certbot 省步骤
- [ ] 申请证书是否少踩坑（DNS/续期/panel.inc）
- [ ] 反代表单是否够用
- [ ] 手改 Caddyfile 是否比手改 Nginx 轻松
- [ ] 停用/换机是否更直观
- [ ] 总心智负担：升 / 平 / 降

## 非目标（本阶段）

远程 Admin API 控多机、HTMX 重写前端、通配符 DNS-01、取代公网 Nginx 主控反代。

## 当前进度（2026-10-23）

- [x] 副本目录与计划文档
- [x] 节点安装改为 Caddy apt 源
- [x] Caddyfile 生成（静态/反代/off/auto）
- [x] 部署/停用/启用走 caddy validate+reload
- [x] SSL 任务改为 DNS 校验后写 auto 站点块（不再 certbot）
- [x] UI 标签 Nginx→Caddy；手改配置保留
- [x] 干净节点实装（济南 103.239.186.54，国内镜像二进制安装约数秒）
- [x] HTTPS UI 改为证书模式 + 部署生效（去掉勾选申请）
- [ ] 部署烟测
- [ ] 自动 HTTPS 实网签发对照
- [ ] 商业证书 custom 上传
- [ ] 用一段时间后填「是否更省心」对照清单

### 安装备注
- **专用机原则**：不更新系统、不装多余包、不改主机 apt 源。
- 安装只做：放 agent + 下载 Caddy 二进制（ghfast/ghproxy/GitHub）+ systemd unit + 目录。
- 机器需自带 `curl`/`tar`/`systemd`；缺了直接报缺，不自动 apt。


## UI 约定（实验）

- 工作区 tab：`配置`（地址/SSL/反代/DNS/变量）→ `Caddy`（只读最终配置）→ `文件`
- 域名 UI 改地址会同步到 Caddyfile 的站点地址行；handler（`/api` 反代等）手写保留
- 不做整站反代开关；路径级反代示例：

```caddyfile
handle /api* {
	reverse_proxy 127.0.0.1:8080
}
handle /uploads* {
	reverse_proxy 127.0.0.1:8080
}
handle {
	root * /srv/site-panel/sites/<id>/current
	try_files {path} /index.html
	file_server
}
```

## 模块边界（后续按块优化）

1. **节点**：SSH / 指纹 / 安装 agent+Caddy / 能力探测。不管站点内容。
2. **站点配置包**：地址、SSL、路径反代、变量 → 生成 Caddyfile。Caddy 页只读最终结果。
3. **文件**：输入只有 `siteId → 主控目录`；上传/解压/树/编辑都在目录内自洽。
4. **部署·任务**：打 bundle、推节点、validate+reload；任务列表按当前节点过滤。
5. **旁路**：DNS 检查、备份、Telegram。可独立开关。

文件模块理想接口：`root(siteId)` 之后不再关心域名/SSL/反代。

## 主控文件布局

- `data/sites/<id>/site/`：唯一打包部署目录（节点 `current`）
- `data/sites/<id>/` 其它内容：playground（压缩包版本、临时文件）
- 灰色 tab：`Caddy` 生成结果、`规格` JSON、`快照` 上次成功部署清单

## 透明查看（灰色 tab）

- 规格：配置页落库 JSON
- Caddy：生成/自定义最终配置
- 打包：publish_path 下将进 bundle.tar 的文件
- 请求：节点 request.json 预览
- 快照：上次成功部署清单
- 阶段：上面这些产物各自干什么

文件页可手设 `publish_path`（空=站点根，`site`，`site/web`…）。
