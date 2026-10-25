import { test, expect } from "@playwright/test";

test("无构建工作台：节点导航、分栏编辑、任务日志和草稿保护", async ({
  page,
  request,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("Failed to load resource"))
      errors.push(m.text());
  });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__csp.push(e.violatedDirective),
    );
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("面板密码").fill("browser-test-password");
  await page.getByRole("button", { name: "创建面板密码", exact: true }).click();
  await expect(page.getByRole("region", { name: "站点列表" })).toBeVisible();
  await page.route("**/api/nodes/probe", (r) =>
    r.fulfill({ json: { fingerprint: "SHA256:browser-test-confirmed" } }),
  );
  await page.getByRole("button", { name: "添加 IP 节点", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill("浏览器测试节点");
  await dialog.getByLabel("IP", { exact: true }).fill("127.0.0.1");
  await dialog.getByLabel("root 密码").fill("not-a-real-password");
  await dialog
    .getByRole("button", { name: "读取 SSH 指纹", exact: true })
    .click();
  await expect(
    dialog.getByText("SHA256:browser-test-confirmed", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "确认指纹，保存节点", exact: true })
    .click();
  await expect(page.locator(".node-row")).toContainText("127.0.0.1");
  const firstNode = page.locator(".node-row").filter({ hasText: "127.0.0.1" });
  await expect(firstNode).toHaveClass(/node-row/);
  await expect(firstNode.getByRole("button", { name: "添加站点", exact: true })).toHaveAttribute("title", "添加站点");
  await expect(firstNode.getByRole("button", { name: "安装 agent", exact: true })).toHaveAttribute("title", "安装 agent");
  await expect(firstNode.getByRole("button", { name: "检查", exact: true })).toHaveAttribute("title", "检查");
  await firstNode.getByRole("button", { name: "添加站点", exact: true }).click();
  await dialog.getByLabel("站点名称").fill("浏览器测试站点");
  await dialog.getByLabel("域名 / IP（空格分隔）").fill("example.test");
  await dialog
    .getByRole("button", { name: "创建并打开工作区", exact: true })
    .click();
  const workspace = page.locator(".site-workspace");
  await expect(workspace).toBeVisible();
  await expect(
    page.locator(".overview-panel .site-row").filter({ hasText: "浏览器测试站点" }),
  ).toBeVisible();
  // row click opens Nginx first
  await expect(workspace.getByRole("tab", { name: "Nginx", exact: true })).toHaveAttribute("aria-selected", "true");
  await workspace.getByRole("tab", { name: "文件", exact: true }).click();
  const siteId = await workspace.getAttribute("data-site-id");
  const toolbar = workspace.locator(".workspace-toolbar");
  await toolbar.getByRole("button", { name: "新建文本", exact: true }).click();
  await dialog.getByLabel("文件相对路径").fill("index.html");
  await dialog.getByRole("button", { name: "创建并编辑", exact: true }).click();
  const html = workspace.locator(
    '.code-editor[data-path="index.html"][data-editor-ready="true"]',
  );
  await expect(html).toBeVisible();
  await expect
    .poll(() =>
      html.evaluate((el) => window.ace.edit(el).session.getMode().$id),
    )
    .toBe("ace/mode/html");
  await html.evaluate((el) => {
    window.__originalEditor = window.ace.edit(el);
    window.__originalEditor.setValue("<h1>Browser test</h1>", -1);
  });
  await html.getByRole("textbox", { name: /文件内容/ }).focus();
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes("/file?path=index.html"),
  );
  await page.keyboard.press("Control+s");
  expect((await saved).ok()).toBeTruthy();
  await expect(
    page.getByRole("button", { name: "打开文件 index.html", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+f");
  await expect(html.locator(".ace_search")).toBeVisible();
  await html.locator(".ace_search_form .ace_search_field").fill("Browser");
  await page.keyboard.press("Escape");
  await expect(workspace).toBeVisible();
  await toolbar.getByRole("button", { name: "新建文本", exact: true }).click();
  await dialog.getByLabel("文件相对路径").fill("assets/app.js");
  await dialog.getByRole("button", { name: "创建并编辑", exact: true }).click();
  const js = workspace.locator(
    '.code-editor[data-path="assets/app.js"][data-editor-ready="true"]',
  );
  await expect(js).toBeVisible();
  await js.evaluate((el) =>
    window.ace.edit(el).setValue("console.log('hello');", -1),
  );
  await toolbar
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "打开文件 assets/app.js", exact: true }),
  ).toBeVisible();
  await workspace.getByRole("tab", { name: "index.html", exact: true }).click();
  await html.evaluate((el) =>
    window.ace.edit(el).setValue("<h1>unsaved draft</h1>", -1),
  );
  await page
    .locator(".overview-tools")
    .getByRole("button", { name: "刷新", exact: true })
    .click();
  const fileDivider = page.getByRole("separator", { name: "调整文件栏宽度" });
  const beforeWidth = await page
    .locator(".file-browser")
    .evaluate((el) => el.getBoundingClientRect().width);
  await fileDivider.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page
        .locator(".file-browser")
        .evaluate((el) => el.getBoundingClientRect().width),
    )
    .toBeGreaterThan(beforeWidth + 15);
  expect(
    await html.evaluate(
      (el) => window.ace.edit(el) === window.__originalEditor,
    ),
  ).toBeTruthy();
  expect(await html.evaluate((el) => window.ace.edit(el).getValue())).toBe(
    "<h1>unsaved draft</h1>",
  );
  await workspace.getByRole("tab", { name: "Nginx", exact: true }).click();
  const config = workspace.locator(
    '[data-config-editor="true"][data-editor-ready="true"]',
  );
  await expect(config).toBeVisible();
  await expect
    .poll(() =>
      config.evaluate((el) => window.ace.edit(el).session.getMode().$id),
    )
    .toBe("ace/mode/nginx");
  expect(
    await config.evaluate((el) => window.ace.edit(el).getReadOnly()),
  ).toBeFalsy();
  await config.evaluate((el) => {
    const editor = window.ace.edit(el);
    editor.setValue(editor.getValue().replace("try_files", "# custom\n        try_files"), -1);
  });
  const savedConfig = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" && r.url().includes("/config"),
  );
  await workspace.getByRole("button", { name: "保存配置", exact: true }).click();
  expect((await savedConfig).ok()).toBeTruthy();
  await expect(workspace.locator(".config-pane .inline-note")).toContainText("自定义配置");
  page.once("dialog", (d) => d.accept());
  const resetConfig = page.waitForResponse(
    (r) =>
      r.request().method() === "DELETE" && r.url().includes("/config"),
  );
  await workspace
    .getByRole("button", { name: "恢复默认生成", exact: true })
    .click();
  expect((await resetConfig).ok()).toBeTruthy();
  await expect(workspace.locator(".config-pane .inline-note")).toContainText("默认生成配置");
  await workspace.getByRole("tab", { name: "文件", exact: true }).click();
  expect(await html.evaluate((el) => window.ace.edit(el).getValue())).toBe(
    "<h1>unsaved draft</h1>",
  );
  await workspace.getByRole("button", { name: "部署", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "请先保存或关闭未保存文件" }),
  ).toBeVisible();
  page.once("dialog", (d) => d.dismiss());
  await page
    .locator(".overview-panel")
    .getByRole("button", { name: /127\.0\.0\.1/ })
    .click();
  await expect(html).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await workspace
    .getByRole("button", { name: "关闭文件 index.html", exact: true })
    .click();
  await page
    .getByRole("button", { name: "打开文件 index.html", exact: true })
    .click();
  await expect(html).toBeVisible();
  await expect
    .poll(() => html.evaluate((el) => window.ace.edit(el).getValue()))
    .toBe("<h1>Browser test</h1>");
  // Failed saves preserve the editor and dirty state; no navigation/poll destroys it.
  await html.evaluate((el) =>
    window.ace.edit(el).setValue("<h1>Updated</h1>", -1),
  );
  await page.route("**/api/sites/*/file?path=index.html", async (r) =>
    r.request().method() === "POST"
      ? r.fulfill({ status: 500, json: { error: "模拟保存失败" } })
      : r.continue(),
  );
  await toolbar
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(workspace.locator(".editor-save-status")).toContainText(
    "未保存",
  );
  expect(await html.evaluate((el) => window.ace.edit(el).getValue())).toBe(
    "<h1>Updated</h1>",
  );
  await page.unroute("**/api/sites/*/file?path=index.html");
  await toolbar
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(workspace.locator(".editor-save-status")).toContainText(
    "已保存",
  );
  const nodeId = (await page.request.get("/api/nodes").then((r) => r.json()))[0]
    .id;
  const task = {
    id: "a".repeat(32),
    node_id: nodeId,
    site_id: siteId,
    status: "succeeded",
    step: "done",
    error: "",
    updated_at: "2026-10-20T10:00:00Z",
  };
  let mockedTasks = [task];
  let delayTaskList = false,
    releaseTaskList,
    delayLogs = false,
    releaseLogs;
  const scopedRequests = [];
  await page.route(/\/api\/tasks(?:\?.*)?$/, async (r) => {
    const node = new URL(r.request().url()).searchParams.get("node_id");
    scopedRequests.push({ kind: "tasks", node });
    const snapshot = mockedTasks.filter((t) => t.node_id === node);
    if (delayTaskList) {
      delayTaskList = false;
      await new Promise((resolve) => {
        releaseTaskList = resolve;
      });
    }
    await r.fulfill({ json: snapshot });
  });
  await page.route(/\/api\/tasks\/[^/]+\/logs(?:\?.*)?$/, async (r) => {
    const node = new URL(r.request().url()).searchParams.get("node_id");
    scopedRequests.push({ kind: "logs", node });
    if (delayLogs && node === nodeId) {
      delayLogs = false;
      await new Promise((resolve) => {
        releaseLogs = resolve;
      });
    }
    if (r.request().failure()) return;
    await r.fulfill({
      json: {
        text:
          node === nodeId
            ? "准备文件\n检查 Nginx\n部署成功\n<img src=x onerror=alert(1)>"
            : "仅属于第二节点的日志",
        remote_error: "",
        observed_at: task.updated_at,
      },
    });
  });
  await page.route("**/api/sites/*/deploy", (r) =>
    r.fulfill({ status: 202, json: { task_id: task.id } }),
  );
  await html.evaluate((el) => {
    window.__beforeLogEditor = window.ace.edit(el);
  });
  page.once("dialog", (d) => d.accept());
  await page.route("**/api/sites/*/dns", (r) =>
    r.fulfill({
      json: {
        ok: true,
        summary: "DNS 对照通过",
        node_ip: "127.0.0.1",
        domains: [{ host: "example.test", ok: true, detail: "example.test → 127.0.0.1（指向节点）" }],
      },
    }),
  );
  await page.route("**/api/sites/*/deploy-preview", (r) =>
    r.fulfill({
      json: {
        has_baseline: true,
        first_deploy: false,
        nginx_changed: false,
        nginx_source: "generated",
        vars_changed: false,
        added: [],
        changed: ["index.html"],
        removed: [],
        unchanged: 0,
        file_count: 1,
        replacements: 0,
        summary: "文件：修改 1；Nginx 无改（index.html）",
        note: "仍全量推送文件与 Nginx",
      },
    }),
  );
  await workspace.getByRole("button", { name: "部署", exact: true }).click();
  const deployDialog = page.getByRole("dialog");
  await expect(deployDialog.getByLabel("部署变更摘要")).toContainText("修改 1");
  await expect(deployDialog.getByLabel("部署变更摘要")).toContainText("index.html");
  await expect(deployDialog.locator(".deploy-diff-list")).toBeVisible();
  await expect(deployDialog.locator(".deploy-diff-line", { hasText: "修改：index.html" })).toBeVisible();
  await expect(deployDialog.getByRole("status").filter({ hasText: /DNS/ })).toBeVisible();
  await expect(deployDialog.getByLabel("部署前 Nginx 配置")).toHaveCount(0);
  await deployDialog.getByRole("button", { name: "部署", exact: true }).click();
  await expect(workspace.getByRole("tab", { name: "站日志", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(
    workspace
      .locator(".task-table-wrap")
      .getByRole("button", { name: /浏览器测试站点/ }),
  ).toBeVisible();
  await expect(workspace.getByLabel("站点执行日志")).toContainText("部署成功");
  expect(await workspace.locator(".log-output img").count()).toBe(0);
  await workspace.getByRole("tab", { name: "文件", exact: true }).click();
  await expect(html).toBeVisible();
  expect(
    await html.evaluate(
      (el) => window.ace.edit(el) === window.__beforeLogEditor,
    ),
  ).toBeTruthy();
  await html.evaluate((el) =>
    window.ace.edit(el).setValue("<h1>Session draft retained</h1>", -1),
  );
  const otherLogin = await request.post("/api/login", {
    data: { password: "browser-test-password" },
  });
  expect(otherLogin.ok()).toBeTruthy();
  await toolbar
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "登录已过期，重新登录后继续编辑",
      exact: true,
    }),
  ).toBeVisible();
  expect(await html.evaluate((el) => window.ace.edit(el).getValue())).toBe(
    "<h1>Session draft retained</h1>",
  );
  await page.waitForTimeout(1100);
  await dialog.getByLabel("面板密码").fill("browser-test-password");
  await dialog.getByRole("button", { name: "重新登录", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await toolbar
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(workspace.locator(".editor-save-status")).toContainText(
    "已保存",
  );
  await page.screenshot({
    path: testInfo.outputPath("workspace-desktop.png"),
    fullPage: true,
  });
  let sslPayload;
  await page.route("**/api/sites/*/ssl", async (r) => {
    sslPayload = r.request().postDataJSON();
    const sslTask = {
      ...task,
      id: "b".repeat(32),
      kind: "ssl",
      step: "ssl_staging_done",
    };
    mockedTasks = [sslTask, task];
    await r.fulfill({ status: 202, json: { task_id: sslTask.id } });
  });
  await workspace.getByRole("tab", { name: "域名&SSL", exact: true }).click();
  await workspace.getByLabel("新域名或 IP", { exact: true }).fill("dl.xfnss.top");
  await workspace.getByRole("button", { name: "添加一行", exact: true }).click();
  await workspace.getByRole("button", { name: "保存域名", exact: true }).click();
  await expect(workspace.getByRole("link", { name: "dl.xfnss.top", exact: true })).toBeVisible();
  // only apply SSL to the new domain
  const exampleSsl = workspace.locator("tr", { hasText: "example.test" }).getByLabel("申请 SSL");
  if (await exampleSsl.isChecked()) await exampleSsl.uncheck();
  await workspace.locator("tr", { hasText: "dl.xfnss.top" }).getByLabel("申请 SSL").check();
  await workspace.getByLabel(/同意/).check();
  await workspace.getByText("高级", { exact: true }).click();
  await workspace.getByLabel(/测试签发/).check();
  await workspace
    .getByRole("button", { name: "申请证书", exact: true })
    .click();
  await expect(workspace.getByRole("tab", { name: "站日志", exact: true })).toHaveAttribute("aria-selected", "true");
  await workspace.getByRole("tab", { name: "域名&SSL", exact: true }).click();
  await expect(
    workspace.getByRole("status").filter({ hasText: "已提交测试申请" }),
  ).toBeVisible();
  expect(sslPayload.domains).toEqual(["dl.xfnss.top"]);
  expect(sslPayload.staging).toBeTruthy();
  expect(sslPayload.agree_terms).toBeTruthy();
  await workspace.getByRole("tab", { name: "文件", exact: true }).click();
  expect(await html.evaluate((el) => window.ace.edit(el).getValue())).toBe(
    "<h1>Session draft retained</h1>",
  );
  // Node-scoped history and stale-response protection for both lists and logs.
  const session = await page.request.get("/api/session").then((r) => r.json());
  const secondResponse = await page.request.post("/api/nodes", {
    headers: { "X-CSRF-Token": session.csrf },
    data: {
      name: "隔离测试节点",
      host: "127.0.0.2",
      port: 22,
      user: "root",
      note: "第二客户",
      password: "not-a-real-password",
      fingerprint: "SHA256:browser-test-confirmed",
    },
  });
  expect(secondResponse.ok()).toBeTruthy();
  const second = await secondResponse.json();
  mockedTasks.push({
    ...task,
    id: "c".repeat(32),
    node_id: second.id,
    site_id: "",
  });
  await page
    .locator(".overview-tools")
    .getByRole("button", { name: "刷新", exact: true })
    .click();
  await expect(page.locator(".node-row")).toHaveCount(2);
  await workspace.getByRole("tab", { name: "站日志", exact: true }).click();
  await expect(workspace.getByLabel("站点执行日志")).toContainText("部署成功");
  await expect(workspace.locator(".task-table-wrap")).not.toContainText("127.0.0.2");
  await expect(workspace.locator(".task-table-wrap tbody tr")).toHaveCount(2);
  delayLogs = true;
  await workspace
    .locator(".log-toolbar")
    .getByRole("button", { name: "刷新日志", exact: true })
    .click();
  await expect.poll(() => typeof releaseLogs).toBe("function");
  delayTaskList = true;
  await workspace
    .locator(".logs-mini-toolbar")
    .getByRole("button", { name: "刷新任务", exact: true })
    .click();
  await expect.poll(() => typeof releaseTaskList).toBe("function");
  const switchRequests = scopedRequests.length;
  page.once("dialog", (d) => d.accept());
  await page.locator(".node-row").filter({ hasText: "127.0.0.2" }).locator(".node-row-main").click();
  await expect(page.locator(".site-workspace")).toHaveCount(0);
  // second node has no site; reopen first site logs and ensure stale responses are ignored
  page.once("dialog", (d) => d.accept());
  await page.locator(".node-row").filter({ hasText: "127.0.0.1" }).locator(".node-row-main").click();
  await page
    .locator(".overview-panel")
    .locator(".site-row")
    .filter({ hasText: "浏览器测试站点" })
    .click();
  const reopenedLogs = page.locator(".site-workspace");
  await expect(reopenedLogs).toBeVisible();
  await reopenedLogs.getByRole("tab", { name: "站日志", exact: true }).click();
  releaseTaskList();
  releaseLogs();
  await page.waitForTimeout(150);
  await expect(reopenedLogs.getByLabel("站点执行日志")).toContainText("部署成功");
  await expect(reopenedLogs.locator(".task-table-wrap")).not.toContainText("127.0.0.2");
  await expect(reopenedLogs.locator(".task-table-wrap tbody tr")).toHaveCount(2);
  expect(
    scopedRequests.slice(switchRequests).some((r) => r.node === second.id),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("node-tasks-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("node-tasks-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".node-row").filter({ hasText: "127.0.0.1" }).click();
  await page
    .locator(".overview-panel")
    .locator(".site-row").filter({ hasText: "浏览器测试站点" })
    .click();
  const reopened = page.locator(".site-workspace");
  await reopened.getByRole("tab", { name: "文件", exact: true }).click();
  await page
    .getByRole("button", { name: "打开文件 index.html", exact: true })
    .click();
  // html handle was from previous workspace instance; reacquire after reopen
  const htmlAgain = reopened.locator(
    '.code-editor[data-path="index.html"][data-editor-ready="true"]',
  );
  await expect(htmlAgain).toBeVisible();
  await expect
    .poll(() => htmlAgain.evaluate((el) => window.ace.edit(el).getValue()))
    .toBe("<h1>Session draft retained</h1>");
  expect(await page.locator("svg.lucide").count()).toBeGreaterThan(12);
  expect(
    await page
      .locator(".btn")
      .first()
      .evaluate((el) => getComputedStyle(el).borderRadius),
  ).toBe("0px");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBeTruthy();
  await expect(page.locator(".overview-panel")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("workspace-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await expect(
    page.locator(".overview-panel .site-row").filter({ hasText: "浏览器测试站点" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("overview-desktop.png"),
    fullPage: true,
  });
  await page
    .locator(".overview-tools")
    .getByRole("button", { name: "退出", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "登录工作台", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});
