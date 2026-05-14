#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repo =
  process.env.OYSTERWORKFLOW_SCREENPIPE_REPO ||
  "https://github.com/ShuxinYang111/screenpipe.git";
const ref =
  process.env.OYSTERWORKFLOW_SCREENPIPE_REF ||
  "oysterworkflow-compatible-v0.3.304";
const installDir =
  process.env.OYSTERWORKFLOW_SCREENPIPE_DIR ||
  path.join(os.homedir(), ".oysterworkflow", "screenpipe");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function resolveTool(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  if (result.status === 0) {
    return command;
  }

  const candidates =
    command === "cargo" ? [path.join(os.homedir(), ".cargo", "bin", "cargo")] : [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const candidateResult = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      shell: false,
    });
    if (candidateResult.status === 0) {
      return candidate;
    }
  }

  return null;
}

function checkTool(command, hint) {
  const resolved = resolveTool(command);
  if (!resolved) {
    throw new Error(`${command} is required. ${hint}`);
  }
  return resolved;
}

await mkdir(path.dirname(installDir), { recursive: true });
const git = checkTool("git", "Install Git and retry.");
const cargo = checkTool("cargo", "Install Rust from https://rustup.rs/ and retry.");

if (!existsSync(path.join(installDir, ".git"))) {
  run(git, ["clone", "--depth", "1", "--branch", ref, repo, installDir]);
} else {
  run(git, ["-C", installDir, "fetch", "--depth", "1", "origin", ref]);
  run(git, ["-C", installDir, "checkout", "-B", ref, "FETCH_HEAD"]);
}

run(cargo, ["build", "--release", "-p", "screenpipe-engine", "--bin", "screenpipe"], {
  cwd: installDir,
});

const binaryPath = path.join(installDir, "target", "release", "screenpipe");
console.log("");
console.log("OysterWorkflow-compatible Screenpipe is ready:");
console.log(binaryPath);
console.log("");
console.log("Start it with:");
console.log("npm run screenpipe:start");
