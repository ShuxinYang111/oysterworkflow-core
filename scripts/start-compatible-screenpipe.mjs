#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const installDir =
  process.env.OYSTERWORKFLOW_SCREENPIPE_DIR ||
  path.join(os.homedir(), ".oysterworkflow", "screenpipe");
const binaryPath =
  process.env.OYSTERWORKFLOW_SCREENPIPE_BIN ||
  path.join(installDir, "target", "release", "screenpipe");

if (!existsSync(binaryPath)) {
  console.error(`Screenpipe binary not found at ${binaryPath}`);
  console.error("Run npm run screenpipe:install first.");
  process.exit(1);
}

const defaultArgs = [
  "record",
  "--port",
  process.env.OYSTERWORKFLOW_SCREENPIPE_PORT || "3030",
  "--disable-audio",
  "--fps",
  process.env.OYSTERWORKFLOW_SCREENPIPE_FPS || "1",
  "--language",
  "chinese",
  "--language",
  "english",
];

const args = [...defaultArgs, ...process.argv.slice(2)];
console.log(`Starting ${binaryPath}`);
console.log(`screenpipe ${args.join(" ")}`);

const child = spawn(binaryPath, args, {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
