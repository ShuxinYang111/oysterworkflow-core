import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseOpenClawSkillInstallCliArgs,
  parseOpenClawSkillUninstallCliArgs,
  resolveOpenClawExecutablePath,
  runOpenClawSkillExport,
  runOpenClawSkillInstall,
  runOpenClawSkillUninstall,
  type OpenClawCommandRunner,
} from "../src/cli/commands/openclaw-skill.js";

function buildSkill(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v3",
    skillId: "skill-001",
    skillName: "Flight Check",
    generatedAt: "2026-03-22T00:00:00.000Z",
    source: {
      runId: "run-001",
      runDir: "/tmp/run-001",
      episodeId: "ep-001",
      startTs: "2026-03-22T00:00:00.000Z",
      endTs: "2026-03-22T00:10:00.000Z",
    },
    shortDescription:
      "Quickly inspect one flight status from the verified path.",
    description: "Check flight status.",
    goal: "Check the latest flight status without booking anything.",
    whenToUse: ["When you need to inspect one flight status."],
    whenNotToUse: ["Do not use for ticket purchases."],
    inputs: ["Flight number"],
    outputs: ["Visible flight status"],
    prerequisites: ["Open a browser session."],
    steps: [
      {
        step: 1,
        instruction: "Open the airline status page.",
        intent: "Navigate to the right workflow.",
        operationApp: "Google Chrome",
        hints: ["Status page"],
      },
      {
        step: 2,
        instruction: "Enter the flight number and inspect the result.",
        intent: "Retrieve the current flight status.",
        operationApp: "Google Chrome",
        hints: ["Flight number"],
      },
    ],
    successCriteria: ["The current flight status is visible on screen."],
    failureModes: ["The site is unavailable."],
    fallback: ["Retry after refreshing the page."],
    examples: ["Check UA100 before heading to the airport."],
    tags: ["travel"],
    assets: {
      credentials: [],
      texts: ["UA100"],
      urls: ["https://example.com/status"],
    },
    evidence: {
      totalEvents: 2,
      anchorEvents: 2,
      ocrEvents: 0,
      appsSeen: ["Google Chrome"],
      windowsSeen: ["Flight Status"],
    },
    ...overrides,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createSourceFiles(input: {
  root: string;
  skill?: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
}): Promise<{
  skillPath: string;
  summaryPath: string;
}> {
  const sourceDir = path.join(input.root, "source");
  await mkdir(sourceDir, { recursive: true });

  const skillPath = path.join(sourceDir, "skill.json");
  const summaryPath = path.join(sourceDir, "summary.json");

  await writeJson(skillPath, input.skill ?? buildSkill());
  if (input.summary !== null) {
    await writeJson(summaryPath, input.summary ?? { runId: "run-001" });
  }

  return { skillPath, summaryPath };
}

function createMockRunner(input: {
  installRoot: string;
  discoveryMode?: "success" | "baseDir-mismatch" | "not-found";
  smokeExitCode?: number;
}): OpenClawCommandRunner {
  return {
    async run(command, args) {
      expect(command).toBe("openclaw");

      if (args[0] === "skills" && args[1] === "info") {
        const installName = String(args[2]);
        if (input.discoveryMode === "not-found") {
          return {
            stdout: JSON.stringify({ error: "not found", skill: installName }),
            stderr: "",
            exitCode: 0,
          };
        }

        return {
          stdout: JSON.stringify({
            name: installName,
            baseDir:
              input.discoveryMode === "baseDir-mismatch"
                ? path.join(input.installRoot, "somewhere-else")
                : path.join(input.installRoot, installName),
            source: "agents-skills-personal",
            eligible: true,
          }),
          stderr: "",
          exitCode: 0,
        };
      }

      if (args[0] === "agent") {
        return {
          stdout: JSON.stringify({ status: "ok", plan: ["step 1", "step 2"] }),
          stderr: "",
          exitCode: input.smokeExitCode ?? 0,
        };
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

describe("openclaw-skill command", () => {
  it("parses install defaults from skill path siblings", () => {
    const parsed = parseOpenClawSkillInstallCliArgs({
      skillPath: "/tmp/run/openclaw-llm/skill.json",
    });

    expect(parsed.skillPath).toBe(
      path.resolve("/tmp/run/openclaw-llm/skill.json"),
    );
    expect(parsed.summaryPath).toBe(
      path.resolve("/tmp/run/openclaw-llm/summary.json"),
    );
    expect(parsed.summaryPathExplicit).toBe(false);
    expect(parsed.run).toBe(false);
  });

  it("prefers an explicit OpenClaw executable override before fallback paths", async () => {
    const checkedPaths: string[] = [];
    const resolved = await resolveOpenClawExecutablePath({
      env: {
        OYSTERWORKFLOW_OPENCLAW_PATH: "~/custom-bin/openclaw",
      },
      isExecutablePath: async (filePath) => {
        checkedPaths.push(filePath);
        return filePath === path.join(os.homedir(), "custom-bin", "openclaw");
      },
    });

    expect(resolved).toBe(path.join(os.homedir(), "custom-bin", "openclaw"));
    expect(checkedPaths[0]).toBe(
      path.join(os.homedir(), "custom-bin", "openclaw"),
    );
  });

  it("falls back to common Homebrew locations when no env override is executable", async () => {
    const checkedPaths: string[] = [];
    const resolved = await resolveOpenClawExecutablePath({
      env: {
        OYSTERWORKFLOW_OPENCLAW_PATH: "/tmp/missing-openclaw",
      },
      isExecutablePath: async (filePath) => {
        checkedPaths.push(filePath);
        return filePath === "/opt/homebrew/bin/openclaw";
      },
    });

    expect(resolved).toBe("/opt/homebrew/bin/openclaw");
    expect(checkedPaths).toEqual([
      path.resolve("/tmp/missing-openclaw"),
      "/opt/homebrew/bin/openclaw",
    ]);
  });

  it("still accepts the legacy OpenClaw executable env var", async () => {
    const checkedPaths: string[] = [];
    const resolved = await resolveOpenClawExecutablePath({
      env: {
        TRACE2OPENCLAW_OPENCLAW_PATH: "~/legacy-bin/openclaw",
      },
      isExecutablePath: async (filePath) => {
        checkedPaths.push(filePath);
        return filePath === path.join(os.homedir(), "legacy-bin", "openclaw");
      },
    });

    expect(resolved).toBe(path.join(os.homedir(), "legacy-bin", "openclaw"));
    expect(checkedPaths[0]).toBe(
      path.join(os.homedir(), "legacy-bin", "openclaw"),
    );
  });

  it("installs a skill without companion summary", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    const result = await runOpenClawSkillInstall({
      ...options,
      now: new Date("2026-03-22T01:00:00.000Z"),
      commandRunner: createMockRunner({ installRoot }),
    });

    expect(result.installName).toBe("generated-flight-check");
    expect(result.sourceSummaryPath).toBeNull();
    await access(
      path.join(result.installDir, "references", "generated-skill.json"),
    );
    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(skillMd).toContain('name: "generated-flight-check"');
    expect(skillMd).toContain("## Goal");
    expect(skillMd).toContain("## Steps");
    expect(skillMd).toContain("references/generated-skill.json");
    const prompt = await readFile(result.testPromptPath, "utf8");
    expect(prompt).toContain(
      'Use the installed skill "generated-flight-check"',
    );
  });

  it("exports a skill without discovery checks or test prompts", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath, summaryPath } = await createSourceFiles({
      root,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      summaryPath,
      installRoot,
    });

    const result = await runOpenClawSkillExport({
      ...options,
      now: new Date("2026-03-22T01:00:00.000Z"),
    });

    expect(result.installName).toBe("generated-flight-check");
    expect(result.sourceSummaryPath).toBe(summaryPath);
    await access(
      path.join(result.installDir, "references", "generated-skill.json"),
    );
    await access(path.join(result.installDir, "references", "summary.json"));
    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(skillMd).toContain('name: "generated-flight-check"');
    await expect(
      access(path.join(result.installDir, "test-prompt.md")),
    ).rejects.toThrow();
  });

  it("installs a skill that already uses structured fields and inline assets", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const longDescription =
      "Prefer this verified learner-generated flow when checking one flight status. " +
      "It preserves the user's original navigation path, keeps the status lookup " +
      "focused on inspection only, and includes the reference materials needed " +
      "to avoid guessing during execution.";
    const { skillPath } = await createSourceFiles({
      root,
      skill: buildSkill({
        skillName: "Structured Flight Check",
        shortDescription:
          "Use this verified flow to inspect one flight status without booking.",
        description: longDescription,
        inputs: [
          {
            name: "Flight number",
            description: "Airline flight number to inspect.",
            required: true,
          },
        ],
        outputs: [
          {
            name: "Flight status",
            description: "Visible live status shown on screen.",
            required: true,
          },
        ],
        assets: [
          {
            type: "url",
            name: "Status page",
            value: "https://example.com/status",
          },
          {
            name: "Reference flights",
            value: ["UA100", "UA101"],
          },
        ],
      }),
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    const result = await runOpenClawSkillInstall({
      ...options,
      commandRunner: createMockRunner({ installRoot }),
    });

    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(result.installName).toBe("generated-structured-flight-check");
    expect(skillMd).toContain(
      'description: "Use this verified flow to inspect one flight status without booking."',
    );
    expect(skillMd).toContain("## Description");
    expect(skillMd).toContain(longDescription);
    expect(skillMd).toContain(
      "- Flight number (required): Airline flight number to inspect.",
    );
    expect(skillMd).toContain(
      "- Flight status (required): Visible live status shown on screen.",
    );
    expect(skillMd).toContain("## Assets");
    expect(skillMd).toContain("- Status page: https://example.com/status");
    expect(skillMd).toContain("- Reference flights: UA100; UA101");
  });

  it("falls back to a truncated full description when shortDescription is missing", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const longDescription =
      "Prefer this verified learner-generated flow when checking one flight status so the agent follows the same trusted path the user already validated in production and does not have to improvise the airline site navigation from scratch. " +
      "Keep this longer body in the markdown description section for humans who need the full context.";
    const { skillPath } = await createSourceFiles({
      root,
      skill: buildSkill({
        shortDescription: undefined,
        description: longDescription,
      }),
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    const result = await runOpenClawSkillInstall({
      ...options,
      commandRunner: createMockRunner({ installRoot }),
    });

    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(skillMd).toContain(
      `description: "${longDescription.slice(0, 280)}"`,
    );
    expect(skillMd).toContain(longDescription);
  });

  it("uses sibling summary when present and appends suffix on conflict", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    await mkdir(path.join(installRoot, "generated-flight-check"), {
      recursive: true,
    });
    const { skillPath, summaryPath } = await createSourceFiles({
      root,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    const result = await runOpenClawSkillInstall({
      ...options,
      commandRunner: createMockRunner({ installRoot }),
    });

    expect(result.installName).toBe("generated-flight-check-V1");
    expect(result.sourceSummaryPath).toBe(summaryPath);
    await access(path.join(result.installDir, "references", "summary.json"));
  });

  it("increments an existing version suffix when the requested install name already exists", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    await mkdir(path.join(installRoot, "generated-flight-check-V2"), {
      recursive: true,
    });
    const { skillPath } = await createSourceFiles({
      root,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
      installName: "generated-flight-check-V2",
    });

    const result = await runOpenClawSkillInstall({
      ...options,
      commandRunner: createMockRunner({ installRoot }),
    });

    expect(result.installName).toBe("generated-flight-check-V3");
  });

  it("fails when skill steps are not sequential", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      skill: buildSkill({
        steps: [
          {
            step: 1,
            instruction: "Open the site.",
            intent: "Navigate.",
            operationApp: "Google Chrome",
            hints: [],
          },
          {
            step: 3,
            instruction: "Inspect the result.",
            intent: "Read the status.",
            operationApp: "Google Chrome",
            hints: [],
          },
        ],
      }),
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    await expect(
      runOpenClawSkillInstall({
        ...options,
        commandRunner: createMockRunner({ installRoot }),
      }),
    ).rejects.toThrow("Invalid skill step sequence");
  });

  it("fails when discovery returns a mismatched baseDir", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    await expect(
      runOpenClawSkillInstall({
        ...options,
        commandRunner: createMockRunner({
          installRoot,
          discoveryMode: "baseDir-mismatch",
        }),
      }),
    ).rejects.toThrow("unexpected baseDir");
  });

  it("keeps the installed directory when smoke test fails", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
      run: true,
    });
    const expectedInstallDir = path.join(installRoot, "generated-flight-check");

    await expect(
      runOpenClawSkillInstall({
        ...options,
        commandRunner: createMockRunner({
          installRoot,
          smokeExitCode: 1,
        }),
      }),
    ).rejects.toThrow("Smoke test failed");

    await access(expectedInstallDir);
    await access(path.join(expectedInstallDir, "test-prompt.md"));
  });

  it("normalizes versioned install names for uninstall lookup", () => {
    const parsed = parseOpenClawSkillUninstallCliArgs({
      name: "generated-flight-check-v2",
    });

    expect(parsed.installName).toBe("generated-flight-check-V2");
  });

  it("runs smoke test with --agent main on local OpenClaw", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
      run: true,
    });
    let capturedAgentArgs: string[] | null = null;
    const runner: OpenClawCommandRunner = {
      async run(command, args) {
        expect(command).toBe("openclaw");

        if (args[0] === "skills" && args[1] === "info") {
          const installName = String(args[2]);
          return {
            stdout: JSON.stringify({
              name: installName,
              baseDir: path.join(installRoot, installName),
              source: "agents-skills-personal",
              eligible: true,
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        if (args[0] === "agent") {
          capturedAgentArgs = args;
          return {
            stdout: JSON.stringify({
              status: "ok",
              plan: ["step 1", "step 2"],
            }),
            stderr: "",
            exitCode: 0,
          };
        }

        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    };

    const result = await runOpenClawSkillInstall({
      ...options,
      commandRunner: runner,
    });

    expect(capturedAgentArgs).toEqual([
      "agent",
      "--agent",
      "main",
      "--local",
      "--json",
      "-m",
      expect.any(String),
    ]);
    expect(result.smokeTest?.command).toEqual([
      "openclaw",
      "agent",
      "--agent",
      "main",
      "--local",
      "--json",
      "-m",
      expect.any(String),
    ]);
  });

  it("uninstalls a generated directory and rejects unmarked folders", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const installResult = await runOpenClawSkillInstall({
      ...parseOpenClawSkillInstallCliArgs({
        skillPath,
        installRoot,
      }),
      commandRunner: createMockRunner({ installRoot }),
    });

    const uninstallResult = await runOpenClawSkillUninstall(
      parseOpenClawSkillUninstallCliArgs({
        name: installResult.installName,
        installRoot,
      }),
    );
    expect(uninstallResult.removed).toBe(true);
    await expect(access(installResult.installDir)).rejects.toThrow();

    const manualDir = path.join(installRoot, "generated-manual-dir");
    await mkdir(manualDir, { recursive: true });
    await expect(
      runOpenClawSkillUninstall(
        parseOpenClawSkillUninstallCliArgs({
          name: "generated-manual-dir",
          installRoot,
        }),
      ),
    ).rejects.toThrow("unmarked directory");
  });

  it("uninstalls directories that still carry the legacy export marker name", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const installResult = await runOpenClawSkillInstall({
      ...parseOpenClawSkillInstallCliArgs({
        skillPath,
        installRoot,
      }),
      commandRunner: createMockRunner({ installRoot }),
    });

    const legacyMarkerPath = path.join(
      installResult.installDir,
      ".trace2openclaw-export.json",
    );
    const currentMarkerPath = path.join(
      installResult.installDir,
      ".oysterworkflow-export.json",
    );
    const markerPayload = JSON.parse(await readFile(currentMarkerPath, "utf8"));
    markerPayload.schemaVersion = "trace2openclaw-openclaw-export-v1";
    await writeJson(legacyMarkerPath, markerPayload);
    await rm(currentMarkerPath);

    const uninstallResult = await runOpenClawSkillUninstall(
      parseOpenClawSkillUninstallCliArgs({
        name: installResult.installName,
        installRoot,
      }),
    );

    expect(uninstallResult.removed).toBe(true);
    await expect(access(installResult.installDir)).rejects.toThrow();
  });
});
