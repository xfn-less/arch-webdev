# 05 本阶段现状（可用版）

更新：2026-10-22。这是日常查阅的主文档；细节实现见代码与 06/08。

## 结论

**可以开新项目用。** 主控已公网反代；静态/APK 部署、SSL、停用/换绑、按站 R2 备份、Telegram 总览已接通。

| 项 | 状态 |
|---|---|
| 面板 | `https://site-panel.xfnss.top` → `127.0.0.1:8090` + `-secure-cookie` |
| 数据 | `/var/lib/site-panel/data/` + `master.key` |
| 推送钥 | `/var/lib/site-panel/id_ed25519`（不要用笔记本钥顶掉） |
| Agent | **0.2.8**（业务 conf + `.panel.inc`） |
| 备份 | age + rclone → R2；meta 小时留 12；sites **按站**日留 3；无改动 skip；无周强制 |
| TG | 专用 bot；每天 06:00 / 18:00（上海）全检汇报，发完删旧只留最新；面板可手动推 |

## 已具备

- 单账号会话 / CSRF；节点添加、指纹、安装、检查
- 站点文件（上传/树/Ace）、变量、Nginx、部署确认（变更摘要，仍全量推）
- DNS 检查（可强制）；SSL HTTP-01（正式主流程，测试在高级）
- 停用 503 / 启用 / 删除 / 换绑；节点任务日志
- 主控 install / migrate / backup / restore 脚本

## 操作最短路径

加节点 → 安装 → 加站 → 传文件 → 部署 → 申请证书 → 改 DNS  
Telegram：@BotFather 新建专用 bot → 拉进工作群 → 顶栏「TG 总览」填 Token+Chat ID；之后早晚自动汇报，也可手动「立刻推送」  

## 备份与密钥

- 配置：`/etc/site-panel/backup.env`、`age.key`（**另存私钥**）、rclone `r2`
- cron：`/etc/cron.d/site-panel-backup`
- 恢复：`/usr/local/libexec/site-panel-restore`（meta/latest + 各站 latest）
- 详见 [08-master-deploy.md](08-master-deploy.md) §5c

## 已知边界

- 中断任务标「待核实」，不自动收尾
- Ubuntu 可探测安装，广测不如 Debian 12
- 小刀节点若未装主控公钥，仍走库内密码
- LiteSSL / TG 失败告警 / 计划任务 / Vue 可视化代理表单：后置
- `docs/01–04` 有过时句，以本文与 08 为准

## 验收烟测

1. 登录面板 → 部署已有站仍 200  
2. 停用 → 域名 503 → 启用恢复  
3. `KIND=meta|sites` 备份第二次为 skip  
4. TG 推送后群里能搜到域名并看到对应 IP  
