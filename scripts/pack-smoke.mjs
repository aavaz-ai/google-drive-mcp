#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${String(result.status)}`);
  return result.stdout.trim();
}

const destination = mkdtempSync(join(tmpdir(), "google-drive-mcp-pack-smoke-"));
try {
  const output = run("npm", ["pack", "--pack-destination", destination]);
  const filename = output.split("\n").at(-1);
  if (!filename?.endsWith(".tgz")) throw new Error("npm pack did not return a tarball filename");
  const tarball = join(destination, filename);
  process.stdout.write(run(process.execPath, [resolve(import.meta.dirname, "packed-npx-smoke.mjs"), tarball]));
  process.stdout.write("\n");
} finally {
  rmSync(destination, { recursive: true, force: true });
}
