import van from "../vendor/van-1.6.1.js";
const { button, div, h2, label, span } = van.tags;
import createElement from "../vendor/lucide/createElement.mjs";
import Server from "../vendor/lucide/icons/server.mjs";
import Globe from "../vendor/lucide/icons/globe.mjs";
import Folder from "../vendor/lucide/icons/folder.mjs";
import FolderOpen from "../vendor/lucide/icons/folder-open.mjs";
import File from "../vendor/lucide/icons/file.mjs";
import Code from "../vendor/lucide/icons/file-code.mjs";
import Config from "../vendor/lucide/icons/file-cog.mjs";
import Search from "../vendor/lucide/icons/search.mjs";
import Plus from "../vendor/lucide/icons/plus.mjs";
import Upload from "../vendor/lucide/icons/upload.mjs";
import Send from "../vendor/lucide/icons/send.mjs";
import Refresh from "../vendor/lucide/icons/refresh-cw.mjs";
import Save from "../vendor/lucide/icons/save.mjs";
import Terminal from "../vendor/lucide/icons/terminal.mjs";
import Chevron from "../vendor/lucide/icons/chevron-right.mjs";
import Close from "../vendor/lucide/icons/x.mjs";
import Logout from "../vendor/lucide/icons/log-out.mjs";
import Arrow from "../vendor/lucide/icons/arrow-right.mjs";
import Copy from "../vendor/lucide/icons/copy.mjs";
import Download from "../vendor/lucide/icons/download.mjs";
import Check from "../vendor/lucide/icons/check.mjs";
import Logs from "../vendor/lucide/icons/scroll-text.mjs";
import Success from "../vendor/lucide/icons/circle-check.mjs";
import Failed from "../vendor/lucide/icons/circle-x.mjs";
import Clock from "../vendor/lucide/icons/clock.mjs";
import Warning from "../vendor/lucide/icons/triangle-alert.mjs";
import Lock from "../vendor/lucide/icons/lock-keyhole.mjs";
import Pencil from "../vendor/lucide/icons/pencil.mjs";
import Ban from "../vendor/lucide/icons/ban.mjs";
import Stethoscope from "../vendor/lucide/icons/stethoscope.mjs";
const icons = {
  server: Server,
  globe: Globe,
  folder: Folder,
  "folder-open": FolderOpen,
  file: File,
  code: Code,
  config: Config,
  search: Search,
  plus: Plus,
  upload: Upload,
  send: Send,
  refresh: Refresh,
  save: Save,
  terminal: Terminal,
  chevron: Chevron,
  close: Close,
  logout: Logout,
  arrow: Arrow,
  copy: Copy,
  download: Download,
  check: Check,
  logs: Logs,
  success: Success,
  failed: Failed,
  clock: Clock,
  warning: Warning,
  lock: Lock,
  pencil: Pencil,
  ban: Ban,
  diagnose: Stethoscope,
};
export function icon(name) {
  return createElement(icons[name] || File, {
    width: 16,
    height: 16,
    "stroke-width": 1.75,
    "aria-hidden": "true",
    focusable: "false",
    class: "icon lucide",
  });
}
export const field = (name, element, hint) =>
  label(
    { class: "field" },
    span({ class: "field-label" }, name),
    element,
    hint ? span({ class: "field-hint" }, hint) : null,
  );
export function action(
  text,
  fn,
  {
    kind = "",
    glyph,
    onError = console.error,
    disabled = () => false,
    title,
  } = {},
) {
  const busy = van.state(false);
  return button(
    {
      type: "button",
      class: `btn ${kind}`,
      title: title || text,
      "aria-label": text,
      disabled: () => busy.val || disabled(),
      onclick: async () => {
        if (busy.val) return;
        busy.val = true;
        try {
          await fn();
        } catch (error) {
          onError(error);
        } finally {
          busy.val = false;
        }
      },
    },
    glyph ? icon(glyph) : null,
    span(text),
  );
}
export function modal(
  title,
  content,
  { beforeClose = () => true, onClose = () => {} } = {},
) {
  const dialog = document.createElement("dialog");
  let closed = false;
  const close = () => {
    if (closed || !beforeClose()) return;
    closed = true;
    onClose();
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  van.add(
    dialog,
    div(
      { class: "dialog-heading" },
      h2(title),
      action("关闭", close, { kind: "quiet", glyph: "close" }),
    ),
    content(close),
  );
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}
export function separator({
  label,
  orientation,
  read,
  write,
  min,
  max,
  reverse = false,
}) {
  let start;
  const coordinate = (event) =>
    orientation === "vertical" ? event.clientX : event.clientY;
  const update = (value) => write(Math.min(max(), Math.max(min, value)));
  const el = div({
    class: `split-handle ${orientation}`,
    role: "separator",
    tabindex: 0,
    "aria-label": label,
    "aria-orientation": orientation,
    onpointerdown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      start = { point: coordinate(event), size: read() };
      el.setPointerCapture(event.pointerId);
    },
    onpointermove: (event) => {
      if (start)
        update(
          start.size + (coordinate(event) - start.point) * (reverse ? -1 : 1),
        );
    },
    onpointerup: () => {
      start = undefined;
    },
    onpointercancel: () => {
      start = undefined;
    },
    onlostpointercapture: () => {
      start = undefined;
    },
    onkeydown: (event) => {
      const negative = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
      const positive = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
      if (event.key === negative || event.key === positive) {
        event.preventDefault();
        update(
          read() + (event.key === positive ? 24 : -24) * (reverse ? -1 : 1),
        );
      }
    },
  });
  return el;
}
