# 07 下一阶段工作计划

本文把近期讨论收成可执行清单，避免上下文丢失后目标漂移。

原则只有两条：

1. **职责内**：行为确定、可回滚、日志带 step，不装智能。
2. **职责外**：能校验就校验；不能校验也要失败说清楚（域名解析、80/443、CA、系统包）。

不做：多人只读、路径改站点名、自动改 DNS/防火墙、历史版本、双向同步。

---

## 0. 已确认产品边界

| 项 | 决定 |
|---|---|
| 使用人数 | 人少，**不做多人/只读**；自己注意单会话 |
| 路径命名 | 继续用站点 ID；不加 slug 软链 |
| 主控机器 | Debian 12，**4C/4G**，公网 + HTTPS 反代到本机面板 |
| 节点系统 | 从「仅 Debian 12」改为 **能力探测**；Debian/Ubuntu LTS 能过探测就能装 |
| 文案 | 本地操作用短词（保存/刷新/检查/安装）；只有推节点叫 **部署** |
| SSL | 业务 conf 与面板 SSL 片段拆开；不用手填证书路径 |
| LiteSSL | litessl.cn；spike 后 **暂不接**（见 [09-litessl-spike.md](09-litessl-spike.md)） |
| 测试签发 | 主流程拿掉或塞「高级」；不是日常必选项 |

---

## 1. 术语规范（UI）

| 场景 | 用词 |
|---|---|
| 写主控文件/Nginx/备注 | **保存** |
| 重读主控 | **刷新** |
| 节点 status | **检查** |
| 装/更新执行器 | **安装** / **更新** |
| 推文件+Nginx 到节点 | **部署** |
| ACME 申请 | **申请证书** |
| 从节点取回证书密文 | **同步证书** |
| 停用/启用/删除 | 停用 / 启用 / 删除 |

长说明只放失败信息或一行 hint。按钮不写长句；上传成功用「已保存，部署后生效」。

---

## 2. 节点安装：能力探测

目标：不锁死发行版名字；**依赖条件满足就能用**。失败打印缺哪条。

### 硬条件

1. root
2. 架构 = 面板提供的二进制（当前 x86_64）
3. `systemctl` 可用
4. 可写：`/etc/nginx/conf.d`、`/var/lib/site-panel`、`/srv/site-panel`、`/usr/local/libexec`
5. 能用 apt 安装 nginx（或已是本面板 `owned` 的 Nginx）
6. `nginx -t` 接受 `conf.d/*.conf` 投放方式
7. 无宝塔；若已有 Nginx，必须有 `owned` 标记，否则拒绝接管

### 软条件

- `ca-certificates`；SSL 时再装 `certbot`（缺了任务日志写明）

### 源

按 `/etc/os-release` 的 `ID` 选受管源列表：Debian 用 debian 源；Ubuntu 用 ubuntu 源。**禁止** Ubuntu 套 bookworm list。

### UI

失败显示探测摘要，例如：`缺: conf.d 不可写`，不要只写「仅支持 Debian 12」。

验收矩阵（测过再标支持）：Debian 12；Ubuntu 22.04 / 24.04。其它过探测可试，未测不宣传。

---

## 3. SSL 稳定设计

### 3.1 拆分配置（核心）

```
/etc/nginx/conf.d/site-panel-<id>.conf   # 业务：root/proxy/server_name/listen
/etc/nginx/site-panel/<id>.panel.inc     # 面板托管：ACME webroot + 证书路径
```

规则：

1. 业务 conf **必须**有一行：`include /etc/nginx/site-panel/<id>.panel.inc;`
2. 默认生成自动带上；自定义保存/部署前检查，缺了则自动插入或明确报错
3. 申请/续期/部署成功后面板**只重写 `.panel.inc`**，不改业务 conf 正文
4. 无证书：inc 仅 ACME；有证书：写入证书路径指令
5. 停用 stub 继续占 HTTP+HTTPS（有证时带原证书路径），返回 503
6. 删除手填证书路径分叉；自定义不再要求用户维护证书路径

### 3.2 域名 ↔ 证书覆盖状态

| 状态 | 行为 |
|---|---|
| 证书 SAN ⊇ 站点域名 | 正常 HTTPS |
| 域名变少（证更大） | 可用；可提示重签收紧 |
| 域名变多/改名未覆盖 | **禁止假装已 HTTPS**；标缺域名；引导按当前域名申请 |
| 节点有证、主控备份失败 | 任务写「备份失败」；「同步证书」；不叫申请失败 |

### 3.3 测试签发

主流程默认正式申请。Staging 移入「高级」或暂藏。

### 3.4 LiteSSL（litessl.cn）

背景：宣传 ACME，宝塔可选。本环境未能稳定打开公开 ACME directory；官网文案偏 FreeSSL/EAB 一类。

Spike：

1. 查清 directory URL、是否要 EAB、条款 URL、certbot 是否可 `--server`
2. 标准 ACME（± EAB）→ UI「证书来源」：Let's Encrypt / LiteSSL
3. 专有 API 过重 → 文档写暂不接，只留 LE

**Spike 结论（2026-10-22）**：litessl.cn 可打开；`acme*.litessl.cn` / `api.litessl.cn` / `acme.freessl.cn` 均 TLS EOF；文案导向 FreeSSL EAB。标准 ACME 未打通 → **本阶段不接 LiteSSL**，证书来源仅 Let's Encrypt。

### 3.5 申请前校验

DNS 明细 + ACME 探测失败带 step。部署 force 可保留；SSL 默认更严。

---

## 4. Agent 版本

- 主控嵌入 MinAgent / Recommended
- 节点页过旧红字，禁用部署/SSL/停用
- 后端门禁保留

---

## 5. 部署任务

已修：stub 不当 previous；HTTP 重试；TLS stub。
继续：DNS 明细、step 日志可对 journal、可选变量替换计数。

---

## 6. 主控公网部署

见 [08-master-deploy.md](08-master-deploy.md)。Debian 12 / 4C4G；面板听 127.0.0.1:8090；前面 HTTPS 反代；备份 data + master.key。

---

## 7. 实施顺序

### P0

1. 本文 + 主控部署文档 ✅
2. UI 术语缩短 ✅
3. SSL `.panel.inc` 拆分 + include 约束 ✅（agent 0.2.7；自定义不再手填证书路径）
4. 域名/证书覆盖状态 ✅（SSL 页对照提示；部署侧原有硬校验保留）
5. Agent 过旧前置提示 ✅（节点页版本提示；后端门禁含至 0.2.6）

### P1

6. 安装能力探测 + Ubuntu 源 ✅
7. DNS 明细展示 ✅（`GET /api/sites/{id}/dns` + 部署/SSL 页）
8. 测试签发移出主流程 ✅（SSL「高级」折叠）
9. LiteSSL spike → **暂不接**（公开 ACME directory TLS EOF；站点指向 FreeSSL/EAB，无稳定 certbot `--server`）

### P2

10. 主控 systemd + 反代验收 ✅（`scripts/install-master.sh` + `deploy/*`；公网机器上按 08 清单验收）
11. 换机短提示、部署日志小透明 ✅（复制站点提示；任务记录「替换 N 处变量」；部署弹窗去掉 Nginx 编辑）
11b. 部署确认显示相对上次成功部署的变更摘要 ✅（仍全量推送；`GET /api/sites/{id}/deploy-preview`）
12. TG 总览（IP/域名/状态推工作群）✅；失败告警 / 计划任务以后再做

每块：单测 → `./scripts/build.sh` → 必要时 browser → agent 行为变则 bump。

---

## 8. 验收清单

1. 新站部署 200
2. 再部署更新；失败保旧站
3. 停用：该域 HTTP+HTTPS 503
4. 启用恢复；无备份明确失败
5. 停用后再部署不卡 503 环
6. 自定义 Nginx + SSL 无需手填路径
7. 域名未覆盖证书时 UI 标缺
8. 旧 agent 禁止部署并提示
9. 主控反代 HTTPS 可登录部署
10. （若接 LiteSSL）申请成功

---

## 9. 关键路径

- `internal/node/node.go` 部署回滚
- `internal/node/site_ops.go` 停用 stub
- `internal/node/ssl.go` / `internal/panel/certificates.go` / `web/js/ssl.js`
- `internal/remote/ssh.go` 安装探测
- `internal/panel/sites.go` DNS
- `web/js/app.js` `workspace.js` `node.js`
- `docs/08-master-deploy.md`
