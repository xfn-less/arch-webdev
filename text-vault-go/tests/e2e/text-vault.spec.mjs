import {test, expect} from "@playwright/test";

test.describe.configure({mode: "serial"});

const firstPassword = "daily-vault-passphrase";
const today = new Date();
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);
const reminderMarker = `@${tomorrow.getMonth() + 1}-${tomorrow.getDate()}`;
const todayHeading = `${today.getFullYear()}·${today.getMonth() + 1}月${today.getDate()}日·${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][today.getDay()]}`;
const tomorrowHeading = `${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日`;

test("an insecure context shows guidance instead of crashing", async ({page}) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", {configurable: true, value: false});
  });
  await page.goto("/");
  await expect(page.getByRole("heading", {name: "需要安全连接"})).toBeVisible();
  await expect(page.getByText("Text Vault 需要 HTTPS 或 localhost 才能使用浏览器加密。")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("setup, add, edit outside-click save, search, and selection search", async ({page, context}) => {
  const runtimeErrors = captureRuntimeErrors(page, new Set(["GET /api/vault 404"]));
  await page.goto("/");
  await page.getByLabel("新主密码", {exact: true}).fill(firstPassword);
  await page.getByLabel("重复主密码", {exact: true}).fill(firstPassword);
  await page.getByRole("button", {name: "创建保险库"}).click();

  const search = page.getByRole("textbox", {name: "搜索"});
  const trigger = page.getByRole("button", {name: "搜索，打开时点击清空，上滑新增，左滑切换排列"});
  await expect(trigger).toBeVisible();
  await expect(search).toBeHidden();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(41, 45, 43)");
  await expect(page.locator("body")).toHaveCSS("background-image", /animal-tile\.svg/);
  await expect(page.locator(".date-heading").last()).toHaveText(todayHeading);
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(search).toBeHidden();
  await page.keyboard.press("o");
  const editor = page.getByRole("textbox", {name: "编辑条目"});
  await editor.fill("\n\n客户A 1.2.3.4\n宝塔\n\n");
  await expect(page.locator(".sync-status")).toHaveAttribute("data-state", "editing");
  await editor.press("Escape");
  await expect(page.locator(".sync-status")).toHaveAttribute("data-state", "clean", {timeout: 5000});
  await expect(page.getByRole("listitem")).toContainText("客户A 1.2.3.4\n宝塔");
  await expect(page.getByRole("listitem").first().locator(".entry-text")).toHaveText("客户A 1.2.3.4\n宝塔");

  await page.keyboard.press("o");
  await editor.fill(`客户B example.com ${reminderMarker}`);
  await page.locator(".sync-status").click();
  await expect(page.locator(".sync-status")).toHaveAttribute("data-state", "clean", {timeout: 5000});
  await expect(page.locator(".river > .river-entry .date-token")).toHaveText(reminderMarker);

  const firstEntry = page.getByText("客户A 1.2.3.4", {exact: false});
  const displayedHeight = await firstEntry.evaluate(node => node.getBoundingClientRect().height);
  await firstEntry.click({position: {x: 2, y: 5}});
  await expect.poll(async () => Math.abs((await editor.boundingBox()).height - displayedHeight)).toBeLessThan(0.1);
  await expect.poll(() => editor.evaluate(node => node.selectionStart)).toBeLessThan(3);
  await editor.fill("客户A 1.2.3.4 已修改");
  await page.locator(".river-entry:not(.reminder-entry) .entry-text").filter({hasText: "客户B example.com"}).click();
  await expect(editor).toHaveCount(0);
  await page.locator(".river-entry:not(.reminder-entry) .entry-text").filter({hasText: "客户B example.com"}).click();
  await expect(editor).toHaveValue(`客户B example.com ${reminderMarker}`);
  await page.locator(".sync-status").click();
  await expect(page.locator(".sync-status")).toHaveAttribute("data-state", "clean", {timeout: 5000});

  await swipeLeft(page, trigger);
  await expect(page).toHaveURL(/order=updated/);
  await expect(page.locator(".date-heading")).toHaveCount(0);
  expect(await page.locator(".river > .river-entry .entry-text").allTextContents()).toEqual([
    `客户B example.com ${reminderMarker}`,
    "客户A 1.2.3.4 已修改",
  ]);
  await swipeLeft(page, trigger);
  await expect(page).not.toHaveURL(/order=updated/);

  await page.keyboard.press("/");
  await search.fill("客户B EXAMPLE.com");
  await expect.poll(async () => (await page.locator(".search-control").boundingBox()).width).toBeGreaterThan(350);
  await expect(search).toHaveCSS("border-top-width", "0px");
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem")).toContainText("客户B example.com");
  await expect(page.locator(".agenda-future")).toHaveCount(0);
  await search.fill("一\n二\n三\n四");
  await expect.poll(async () => (await search.boundingBox()).height).toBeGreaterThan(70);
  await expect.poll(async () => (await search.boundingBox()).height).toBeLessThan(97);
  await search.fill("不存在");
  await expect(page.locator(".date-heading")).toHaveCount(0);
  await search.fill("客户B EXAMPLE.com");
  await page.locator(".date-heading").click();
  await expect(search).toBeVisible();
  await expect.poll(async () => (await page.locator(".search-control").boundingBox()).height).toBeLessThanOrEqual(50);
  await page.getByText("客户B example.com", {exact: false}).click();
  await page.getByRole("textbox", {name: "编辑条目"}).press("Escape");
  await expect(search).toHaveValue("客户B EXAMPLE.com");
  await page.keyboard.press("/");
  await expect(search).toHaveValue("客户B EXAMPLE.com");
  await page.keyboard.press("Escape");
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page).not.toHaveURL(/#q=/);
  await page.keyboard.press("/");
  await search.fill("   ");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await page.getByText("客户A 1.2.3.4 已修改").evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const selectionSearch = page.getByRole("button", {name: "在新标签搜索选中文字"});
  await expect(selectionSearch).toBeVisible();
  const opened = context.waitForEvent("page");
  await selectionSearch.click();
  const newTab = await opened;
  await expect(newTab).toHaveURL(/#q=/);
  await newTab.close();
  await expect(editor).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("default river groups today and previews future date markers", async ({page}) => {
  await page.goto("/");
  await page.getByLabel("主密码").fill(firstPassword);
  await page.getByRole("button", {name: "解锁"}).click();

  await expect(page.locator(".date-heading").first()).toHaveText(todayHeading);
  const futureAdd = page.getByRole("button", {name: "新增条目"});
  await expect(futureAdd).toBeVisible();
  await expect(page.locator(".agenda-future .date-main")).toContainText(tomorrowHeading);
  await expect(page.locator(".agenda-future")).toContainText(`客户B example.com ${reminderMarker}`);
  await expect(page.locator(".agenda-future .date-token")).toHaveText(reminderMarker);
  await expect(page.locator(".agenda-future .date-token")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const futureDate = page.locator(".agenda-future .date-heading");
  await futureDate.hover();
  await expect(futureDate).toHaveCSS("opacity", "0.65");
  const futureReminder = page.locator(".agenda-future .reminder-entry");
  await futureReminder.hover();
  await expect(futureReminder).toHaveCSS("opacity", "0.65");
  await futureReminder.locator(".reminder-text").click({position: {x: 2, y: 5}});
  const futureEditor = page.locator(".agenda-future .entry-editor");
  await expect(futureEditor).toBeFocused();
  await expect(futureEditor).toHaveValue(`客户B example.com ${reminderMarker}`);
  await futureEditor.press("Escape");
  await futureAdd.click();
  await expect(page.getByRole("textbox", {name: "编辑条目"})).toBeFocused();
  await page.getByRole("textbox", {name: "编辑条目"}).press("Escape");

  await page.keyboard.press("/");
  await page.getByRole("textbox", {name: "搜索"}).fill("客户B");
  await expect(page).toHaveURL(/#q=/);
  await expect(page.locator(".agenda-future")).toHaveCount(0);
});

test("a second tab unlocks and receives incremental changes", async ({browser}) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await first.goto("/");
  await first.getByLabel("主密码").fill(firstPassword);
  await first.getByRole("button", {name: "解锁"}).click();
  await expect(first.getByRole("list", {name: "条目河流"})).toBeVisible();

  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("list", {name: "条目河流"})).toBeVisible();
  await expect(second.getByLabel("主密码", {exact: true})).toHaveCount(0);
  await expect(second.locator(".river-entry:not(.reminder-entry)")).toHaveCount(2);

  await first.locator(".river-entry:not(.reminder-entry) .entry-text").filter({hasText: "客户B example.com"}).click();
  await first.getByRole("textbox", {name: "编辑条目"}).fill("客户B example.com 已同步");
  await first.locator(".sync-status").click();
  await expect(second.getByRole("listitem").filter({hasText: "已同步"})).toBeVisible({timeout: 7000});
  await context.close();
});

test("mobile uses the same river and default controls", async ({browser}) => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("主密码").fill(firstPassword);
  await page.getByRole("button", {name: "解锁"}).click();
  await expect(page.getByRole("list", {name: "条目河流"})).toBeVisible();
  const trigger = page.getByRole("button", {name: "搜索，打开时点击清空，上滑新增，左滑切换排列"});
  await expect(trigger).toBeVisible();
  await page.locator(".entry-text").first().evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("button", {name: "在新标签搜索选中文字"})).toBeVisible();
  await trigger.click();
  const mobileSearch = page.getByRole("textbox", {name: "搜索"});
  await expect(mobileSearch).toBeFocused();
  await mobileSearch.fill("客户");
  await mobileSearch.press("Escape");
  await expect(mobileSearch).toBeVisible();
  await expect(mobileSearch).not.toBeFocused();
  const mobileEntries = page.locator(".river-entry:not(.reminder-entry) .entry-text");
  await mobileEntries.first().click();
  await expect(page.getByRole("textbox", {name: "编辑条目"})).toBeVisible();
  await expect(trigger).toHaveCSS("opacity", "1");
  const otherMobileEntry = page.locator(".river-entry:not(.reminder-entry) .entry-text").filter({hasText: "客户B"});
  await otherMobileEntry.click();
  await expect(page.getByRole("textbox", {name: "编辑条目"})).toHaveCount(0);
  await otherMobileEntry.click();
  await expect(page.getByRole("textbox", {name: "编辑条目"})).toBeVisible();
  await page.locator(".sync-status").click();
  await trigger.click();
  await expect(mobileSearch).toBeHidden();
  await trigger.dispatchEvent("pointerdown", {pointerId: 2, clientX: 40, clientY: 60});
  await trigger.dispatchEvent("pointerup", {pointerId: 2, clientX: 40, clientY: 10});
  await expect(page.getByRole("textbox", {name: "编辑条目"})).toBeVisible();
  await expect(trigger).toHaveCSS("opacity", "1");
  await page.locator(".sync-status").click();
  await expect(page.locator(".river-entry:not(.reminder-entry)")).toHaveCount(2);
  await context.close();
});

function captureRuntimeErrors(page, allowedResponses = new Set()) {
  const errors = [];
  page.on("console", message => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.status() < 400) return;
    const request = response.request();
    const url = new URL(response.url());
    const summary = `${request.method()} ${url.pathname} ${response.status()}`;
    if (!allowedResponses.has(summary)) errors.push(summary);
  });
  return errors;
}

async function swipeLeft(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + box.height / 2);
  await page.mouse.up();
}
