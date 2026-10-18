# Text Vault Lite

练习骨架：**SQLite 明文存储** + 数据 → 查询 → 视图。没有加密、没有复杂同步；以后缺什么再加。

## 运行

Node 22.5+：

```sh
npm install
npm run dev
```

打开 <http://127.0.0.1:8788>。数据库：`data/text-vault-lite.sqlite`。

## 有什么

- 列表、搜索（`#q=` 子串）、新增/编辑/删除
- 后端 SQLite：`GET/PUT/DELETE /api/entries`

## 阅读顺序

1. `web/js/app.js`
2. `web/js/repository.js`
3. `web/js/core/query.js`
4. `web/js/browser/query-location.js`
5. `web/js/views/river.js`
6. `web/js/api.js` → `src/server.js` → `src/db.js`

```text
浏览器:  repository ← query ← river
              ↕ api.js
服务器:  SQLite entries 表
```

测试：`npm test`。
