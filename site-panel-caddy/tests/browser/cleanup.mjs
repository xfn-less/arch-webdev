import {rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
export default function cleanup() {
  const path = process.env.SITE_PANEL_TEST_DATA;
  if (path?.startsWith(join(tmpdir(), "site-panel-browser-"))) rmSync(path, {recursive: true, force: true});
}
