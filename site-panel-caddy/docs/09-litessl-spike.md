# 09 LiteSSL spike

日期：2026-10-22

## 结论

**暂不接入** LiteSSL / FreeSSL 作为面板证书来源。

## 探测

| 目标 | 结果 |
|---|---|
| https://litessl.cn | 200，营销站；称 ACME / FreeSSL 集成 |
| https://acme.litessl.cn/directory 等 | TLS unexpected EOF |
| https://acme.freessl.cn/directory | TLS unexpected EOF |
| FreeSSL 文档入口 | 导向 EAB 管理（登录墙） |

## 决策

标准 ACME（± EAB）未在本环境打通，不增加证书来源下拉。继续只用 Let's Encrypt。若后续拿到稳定 directory + EAB 流程，再开 P1 补丁。
