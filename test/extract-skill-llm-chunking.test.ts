import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queuedResponses = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("js-tiktoken", () => ({
  getEncoding() {
    return {
      encode(text: string) {
        return new Array(Math.max(1, Math.ceil(text.length / 3))).fill(0);
      },
    };
  },
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();

  return {
    ...actual,
    fetch: vi.fn(async () => {
      const payload = queuedResponses.shift() ?? {
        output_text: JSON.stringify({}),
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      };
      return new actual.Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
});

import { extractOpenClawSkillLlm } from "../src/skill/extract-openclaw-llm.js";
import type { Episode, NormalizedEvent } from "../src/types/contracts.js";

function buildEvent(input: {
  id: string;
  tsMs: number;
  eventType?: NormalizedEvent["eventType"];
  textContent?: string | null;
  windowName?: string | null;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "ocr" ? "search-ocr" : "ui-events",
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    appName: "Google Chrome",
    windowName: input.windowName ?? "Chunking Test Window",
    eventType: input.eventType ?? "text",
    textContent: input.textContent ?? null,
    x: null,
    y: null,
    keyCode: null,
    modifiers: null,
    browserUrl: null,
    frameId: null,
    rawRef: {
      file: "/tmp/events.ndjson",
      line: 1,
    },
  };
}

async function writeRunFixture(runDir: string, episode: Episode): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify({ runId: episode.runId })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "episodes.json"),
    `${JSON.stringify([episode], null, 2)}\n`,
    "utf8",
  );
}

async function loadTraceRecords(runDir: string): Promise<Record<string, unknown>[]> {
  const traceDir = path.join(runDir, "llm-trace");
  const files = (await readdir(traceDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  return Promise.all(
    files.map(async (file) =>
      JSON.parse(
        await readFile(path.join(traceDir, file), "utf8"),
      ) as Record<string, unknown>,
    ),
  );
}

function getTraceUserText(trace: Record<string, unknown>): string {
  const request = trace.request as Record<string, unknown>;
  const body = request.body as Record<string, unknown>;
  const input = Array.isArray(body.input) ? body.input : [];
  return String(input?.[1]?.content?.[0]?.text ?? "");
}

describe("extractOpenClawSkillLlm chunked call B", () => {
  beforeEach(() => {
    queuedResponses.splice(0, queuedResponses.length);
  });

  it("splits long call B input into multiple step chunks and keeps each chunk under the token budget", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "long traceTest Skill",
          goal: "Completelong traceWorkflow.",
        }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Completefirst halfWorkflow.",
              intent: "long trace.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "c16",
        }),
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          total_tokens: 230,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Completesecond halfWorkflow.",
              intent: "long trace after .",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "c20",
        }),
        usage: {
          input_tokens: 180,
          output_tokens: 28,
          total_tokens: 208,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Completesecond halfWorkflow.",
              intent: "long trace after .",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "c20",
          description: "Used to verifylong tracechunked continuation.",
          whenToUse: ["Needverify call B chunking."],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: ["The workflow is fully split and outputs steps."],
          failureModes: [],
          fallback: [],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 160,
          output_tokens: 24,
          total_tokens: 184,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-chunking-"),
    );
    const runDir = path.join(root, "runs", "run-llm-chunking");
    const base = Date.parse("2026-03-24T20:00:00.000Z");
    const longText = "chunk-budget-check-".repeat(420);
    const episode: Episode = {
      id: "run-llm-chunking-ep-0001",
      runId: "run-llm-chunking",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 19_000).toISOString(),
      durationMs: 19_000,
      eventsCount: 20,
      events: Array.from({ length: 20 }, (_, index) =>
        buildEvent({
          id: `c${index + 1}`,
          tsMs: base + index * 1_000,
          textContent: `${index + 1}:${longText}`,
          windowName: `Chunking Window ${index + 1}`,
        }),
      ),
    };
    await writeRunFixture(runDir, episode);

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T20:10:00.000Z"),
    });

    expect(result.skill.steps).toHaveLength(2);
    const traces = await loadTraceRecords(runDir);
    const stepOne =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-step-01",
      ) ?? null;
    const stepTwo =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-terminal-02",
      ) ?? null;
    expect(stepOne).not.toBeNull();
    expect(stepTwo).not.toBeNull();
    expect((stepOne?.meta as Record<string, unknown>)?.estimatedInputTokens).toBeLessThanOrEqual(47_000);
    expect((stepTwo?.meta as Record<string, unknown>)?.estimatedInputTokens).toBeLessThanOrEqual(47_000);

    const terminalUserText = getTraceUserText(stepTwo as Record<string, unknown>);
    expect(terminalUserText).toContain('"id": "c9"');
    expect(terminalUserText).toContain('"id": "c17"');
    expect(terminalUserText).toContain("Current mode: skill-extraction-terminal");
    expect(terminalUserText).toContain(
      "steps, assets, coveredThroughEventId, coveredThroughTsMs, shortDescription, description, whenToUse, whenNotToUse, inputs, outputs, prerequisites, successCriteria, failureModes, fallback, examples, tags",
    );
    expect(terminalUserText).toContain("The last event ID in the current terminal chunk is: c20");
  });

  it("falls back to the chunk end when coveredThroughEventId is invalid", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "Cursor Fallback Skill",
          goal: "Verify cursor fallback.",
        }),
        usage: {
          input_tokens: 101,
          output_tokens: 19,
          total_tokens: 120,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Read page information.",
              intent: "Verify the cursor fallback logic.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "missing-event",
        }),
        usage: {
          input_tokens: 120,
          output_tokens: 22,
          total_tokens: 142,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Complete the tail-end workflow.",
              intent: "second halfWorkflow.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "f20",
          description: "Used to verifythe fallback logic for an invalid cursor.",
          whenToUse: ["Needverifying cursor fallback."],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: ["Even if the cursor is invalid, processing can still advance to the end of the chunk."],
          failureModes: [],
          fallback: [],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 80,
          output_tokens: 18,
          total_tokens: 98,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-cursor-fallback-"),
    );
    const runDir = path.join(root, "runs", "run-llm-cursor-fallback");
    const base = Date.parse("2026-03-24T21:00:00.000Z");
    const longText = "cursor-fallback-".repeat(420);
    const episode: Episode = {
      id: "run-llm-cursor-fallback-ep-0001",
      runId: "run-llm-cursor-fallback",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 19_000).toISOString(),
      durationMs: 19_000,
      eventsCount: 20,
      events: Array.from({ length: 20 }, (_, index) =>
        buildEvent({
          id: index === 19 ? "f20" : `f${index + 1}`,
          tsMs: base + index * 1_000,
          textContent: `${index + 1}:${longText}`,
          windowName: "Cursor Fallback Window",
        }),
      ),
    };
    await writeRunFixture(runDir, episode);

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T21:10:00.000Z"),
    });

    expect(result.summary.warnings.some((warning) => warning.includes("invalid coveredThroughEventId"))).toBe(true);
    const traces = await loadTraceRecords(runDir);
    const stepTrace =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-step-01",
      ) ?? null;
    expect(stepTrace).not.toBeNull();
    expect((stepTrace?.meta as Record<string, unknown>)?.returnedCursorEventId).toBe(
      "missing-event",
    );
    expect((stepTrace?.meta as Record<string, unknown>)?.usedFallbackCursor).toBe(
      true,
    );
  });

  it("allows a chunk to advance without emitting new steps", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "Empty Step Chunk Skill",
          goal: "Verify that an empty-step chunk does not interrupt the workflow.",
        }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Complete the main operation.",
              intent: "first halfkeyStep.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "z16",
        }),
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          total_tokens: 230,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [],
          coveredThroughEventId: "z20",
          description: "Used to verifyfault tolerance for an empty-step chunk.",
          whenToUse: ["Needverifying an empty-step chunk."],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: ["An empty-step chunk can still advance and complete the final skill."],
          failureModes: [],
          fallback: [],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 180,
          output_tokens: 20,
          total_tokens: 200,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-empty-step-chunk-"),
    );
    const runDir = path.join(root, "runs", "run-llm-empty-step-chunk");
    const base = Date.parse("2026-03-24T22:00:00.000Z");
    const longText = "empty-step-chunk-".repeat(420);
    const episode: Episode = {
      id: "run-llm-empty-step-chunk-ep-0001",
      runId: "run-llm-empty-step-chunk",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 19_000).toISOString(),
      durationMs: 19_000,
      eventsCount: 20,
      events: Array.from({ length: 20 }, (_, index) =>
        buildEvent({
          id: `z${index + 1}`,
          tsMs: base + index * 1_000,
          textContent: `${index + 1}:${longText}`,
          windowName: `Empty Step Chunk Window ${index + 1}`,
        }),
      ),
    };
    await writeRunFixture(runDir, episode);

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T22:10:00.000Z"),
    });

    expect(result.skill.steps).toHaveLength(1);
    expect(
      result.summary.warnings.some((warning) =>
        warning.includes("returned no new steps"),
      ),
    ).toBe(true);
    const traces = await loadTraceRecords(runDir);
    const stepTwo =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-terminal-02",
      ) ?? null;
    expect(stepTwo).not.toBeNull();
    expect((stepTwo?.meta as Record<string, unknown>)?.returnedCursorEventId).toBe(
      "z20",
    );
    expect((stepTwo?.meta as Record<string, unknown>)?.usedFallbackCursor).toBe(
      false,
    );
  });
});
