import {mkdir, rm} from "node:fs/promises";

export default async function setup() {
  await rm(".tmp/e2e-data", {recursive: true, force: true});
  await mkdir(".tmp/e2e-data", {recursive: true, mode: 0o700});
}
