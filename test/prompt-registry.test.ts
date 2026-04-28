import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPromptSet,
  renderPromptTemplate,
} from "../src/skill/prompt-registry.js";

describe("prompt-registry", () => {
  it("loads prompt set and validates name", async () => {
    const promptSet = await loadPromptSet("specific-v21");
    expect(promptSet.promptSet).toBe("specific-v21");
    expect(promptSet.schemaVersion).toBe("oysterworkflow-promptset-v1");
    expect(promptSet.filePath).toContain(
      path.join("config", "promptsets", "specific-v21.json"),
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "skill-extraction-step",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "skill-extraction-terminal",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "coveredThroughEventId",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "shortDescription",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "the last event seen and consumed in this round",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "required fields name and value",
    );
    expect(promptSet.workflowDiscovery.userPreamble.join("\n")).toContain(
      "Raw activity log:",
    );
    expect(promptSet.skillExtraction.userPreamble.join("\n")).toContain(
      "The current mode will be provided later in the input.",
    );
    expect(promptSet.scenarioPrediction?.system.join("\n")).toContain(
      "similar or identical workflow",
    );
    expect(promptSet.plannerOptimization?.system.join("\n")).toContain(
      "Instructions for whenToUse:",
    );
    expect(promptSet.plannerOptimization?.system.join("\n")).toContain(
      "mostly positive match conditions",
    );
    expect(promptSet.scenarioPrediction?.userPreamble).toEqual([]);
    expect(promptSet.scenarioGeneralization?.userPreamble).toEqual([]);
    expect(promptSet.scenarioGeneralization?.system.join("\n")).toContain(
      "By default, assume the skill should execute from scratch.",
    );
    expect(promptSet.scenarioGeneralization?.system.join("\n")).toContain(
      "Element Category",
    );
  });

  it("loads specific-v14 without promptSet mismatch", async () => {
    const promptSet = await loadPromptSet("specific-v14");
    expect(promptSet.promptSet).toBe("specific-v14");
    expect(promptSet.filePath).toContain(
      path.join("config", "promptsets", "specific-v14.json"),
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "skill-extraction-finalize",
    );
  });

  it("rejects mismatched promptSet name", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-promptset-"),
    );
    const filePath = path.join(root, "wrong.json");
    const payload = {
      schemaVersion: "oysterworkflow-promptset-v1",
      promptSet: "other",
      workflowDiscovery: { system: ["sys"], userPreamble: ["user"] },
      skillExtraction: { system: ["sys"], userPreamble: ["user"] },
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await expect(loadPromptSet("wrong", root)).rejects.toThrow(
      /Prompt set mismatch/,
    );
  });

  it("renders templates and detects unresolved placeholders", () => {
    const rendered = renderPromptTemplate(["hello {{name}}"], {
      name: "world",
    });
    expect(rendered).toBe("hello world");
    expect(() => renderPromptTemplate(["{{missing}}"], {})).toThrow(
      /Unresolved prompt placeholders/,
    );
  });
});
