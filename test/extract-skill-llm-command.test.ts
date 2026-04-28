import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseExtractSkillLlmCliArgs,
  resolveExtractSkillLlmOptions,
} from "../src/cli/commands/extract-skill-llm.js";

/**
 * EN: Creates an isolated temporary directory to avoid touching real project files.
 * @returns absolute path of the temp directory.
 */
async function makeTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "oysterworkflow-llm-config-"));
}

describe("extract-skill-llm command config resolution", () => {
  const originalTestApiKey = process.env.TEST_LLM_API_KEY;
  // EN: Should parse CLI config argument and map it to configPath.
  it("parses --config into typed options", () => {
    const parsed = parseExtractSkillLlmCliArgs({
      runDir: "/tmp/run",
      config: "/tmp/custom-llm.json",
      enablePlannerOptimization: false,
    });

    expect(parsed.runDir).toBe("/tmp/run");
    expect(parsed.configPath).toBe("/tmp/custom-llm.json");
    expect(parsed.components).toEqual({
      plannerOptimization: {
        enabled: false,
      },
    });
  });
  // EN: Should load model/baseUrl/apiKey from config file when CLI does not override them.
  it("loads values from config file", async () => {
    const root = await makeTempRoot();
    const runDir = path.join(root, "runs", "run-001");
    const configPath = path.join(root, "llm.json");

    await mkdir(runDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mode: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          model: "example-model",
          apiKey: "example-key",
          responseReadTimeoutMs: 120000,
          responseTimeoutMode: "idle",
          components: {
            plannerOptimization: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const resolved = await resolveExtractSkillLlmOptions({
      runDir,
      configPath,
    });

    expect(resolved.baseUrl).toBe("https://api.example.com/v1");
    expect(resolved.model).toBe("example-model");
    expect(resolved.apiKey).toBe("example-key");
    expect(resolved.responseReadTimeoutMs).toBe(120000);
    expect(resolved.responseTimeoutMode).toBe("idle");
    expect(resolved.components).toEqual({
      plannerOptimization: {
        enabled: false,
      },
    });
  });
  // EN: Explicit CLI values should take precedence over config file values.
  it("prefers CLI overrides over config file", async () => {
    const root = await makeTempRoot();
    const runDir = path.join(root, "runs", "run-002");
    const configPath = path.join(root, "llm.json");

    await mkdir(runDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mode: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          model: "example-model",
          apiKey: "example-key",
          components: {
            plannerOptimization: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const resolved = await resolveExtractSkillLlmOptions({
      runDir,
      configPath,
      baseUrl: "https://api.override.com/v1",
      model: "override-model",
      apiKey: "override-key",
      components: {
        plannerOptimization: {
          enabled: true,
        },
      },
    });

    expect(resolved.baseUrl).toBe("https://api.override.com/v1");
    expect(resolved.model).toBe("override-model");
    expect(resolved.apiKey).toBe("override-key");
    expect(resolved.components).toEqual({
      plannerOptimization: {
        enabled: true,
      },
    });
  });
  // EN: Config can resolve key from `apiKeyEnv`/`${ENV}` and propagate wireApi/reasoningEffort.
  it("resolves env-based api key and advanced config fields", async () => {
    const root = await makeTempRoot();
    const runDir = path.join(root, "runs", "run-003");
    const configPath = path.join(root, "llm.json");

    process.env.TEST_LLM_API_KEY = "env-test-key";
    await mkdir(runDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mode: "openai-compatible",
          provider: "openai-compatible",
          baseUrl: "https://proxy.example.com/openai",
          wireApi: "responses",
          model: "gpt-5.3-codex",
          reasoningEffort: "xhigh",
          responseReadTimeoutMs: 120000,
          responseTimeoutMode: "idle",
          clientProfile: "openai-js",
          extraHeaders: {
            "X-Test-Client": "test-probe",
          },
          callProfiles: {
            "workflow-discovery": {
              reasoningEffort: "xhigh",
              responseReadTimeoutMs: 90000,
            },
            "skill-extraction-step": {
              reasoningEffort: "medium",
              responseReadTimeoutMs: 90000,
            },
            "skill-extraction-terminal": {
              reasoningEffort: "medium",
              responseReadTimeoutMs: 90000,
            },
            "scenario-prediction": {
              reasoningEffort: "xhigh",
              responseReadTimeoutMs: 180000,
            },
          },
          apiKey: "${TEST_LLM_API_KEY}",
          apiKeyEnv: "TEST_LLM_API_KEY",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const resolved = await resolveExtractSkillLlmOptions({
      runDir,
      configPath,
    });

    expect(resolved.baseUrl).toBe("https://proxy.example.com/openai");
    expect(resolved.model).toBe("gpt-5.3-codex");
    expect(resolved.wireApi).toBe("responses");
    expect(resolved.reasoningEffort).toBe("xhigh");
    expect(resolved.responseReadTimeoutMs).toBe(120000);
    expect(resolved.responseTimeoutMode).toBe("idle");
    expect(resolved.clientProfile).toBe("openai-js");
    expect(resolved.extraHeaders).toEqual({
      "X-Test-Client": "test-probe",
    });
    expect(resolved.callProfiles).toEqual({
      "workflow-discovery": {
        reasoningEffort: "xhigh",
        responseReadTimeoutMs: 90000,
      },
      "skill-extraction-step": {
        reasoningEffort: "medium",
        responseReadTimeoutMs: 90000,
      },
      "skill-extraction-terminal": {
        reasoningEffort: "medium",
        responseReadTimeoutMs: 90000,
      },
      "scenario-prediction": {
        reasoningEffort: "xhigh",
        responseReadTimeoutMs: 180000,
      },
    });
    expect(resolved.apiKey).toBe("env-test-key");
  });

  it("accepts the codex-desktop client profile from config", async () => {
    const root = await makeTempRoot();
    const runDir = path.join(root, "runs", "run-003b");
    const configPath = path.join(root, "llm.json");

    await mkdir(runDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mode: "openai-compatible",
          baseUrl: "https://proxy.example.com/openai",
          wireApi: "responses",
          model: "gpt-5.4",
          clientProfile: "codex-desktop",
          apiKey: "example-key",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const resolved = await resolveExtractSkillLlmOptions({
      runDir,
      configPath,
    });

    expect(resolved.clientProfile).toBe("codex-desktop");
  });

  it("rejects removed legacy config keys", async () => {
    const root = await makeTempRoot();
    const runDir = path.join(root, "runs", "run-004");
    const configPath = path.join(root, "llm.json");

    await mkdir(runDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mode: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          model: "example-model",
          enableCallC: false,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await expect(
      resolveExtractSkillLlmOptions({
        runDir,
        configPath,
      }),
    ).rejects.toThrow(/enableCallC has been removed/);
  });
  // EN: Restores environment variable to avoid polluting other tests.
  afterAll(() => {
    if (typeof originalTestApiKey === "string") {
      process.env.TEST_LLM_API_KEY = originalTestApiKey;
      return;
    }
    delete process.env.TEST_LLM_API_KEY;
  });
});
