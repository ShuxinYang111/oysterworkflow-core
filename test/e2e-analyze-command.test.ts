import { describe, expect, it } from "vitest";
import { selectE2eAnalyzeCases } from "../src/cli/commands/e2e-analyze.js";
import type { E2eCaseDefinition } from "../src/e2e/case-fixtures.js";

function createCase(id: string): E2eCaseDefinition {
  return {
    id,
    title: id,
    description: `${id} description`,
    sourceRunId: `${id}-run`,
    from: "2026-03-01T00:00:00Z",
    to: "2026-03-01T00:10:00Z",
    apps: "*",
    sourceDir: `${id}/source`,
    expectedRawUiEvents: 1,
    expectedRawOcr: 1,
    minQualityScore: 40,
    expectedWindowKeywords: [id],
    minAutonomousIdealScore: 70,
  };
}

describe("e2e-analyze default case selection", () => {
  it("defaults to the two fixed regression baseline cases", () => {
    const selected = selectE2eAnalyzeCases({
      catalogCases: [
        createCase("career_motivation_benefits_infographic_submission"),
        createCase("insurance_claim_status_check"),
        createCase("bilibili_learning_and_notes"),
      ],
      hasExplicitCasesPath: false,
    });

    expect(selected.map((item) => item.id)).toEqual([
      "bilibili_learning_and_notes",
      "insurance_claim_status_check",
    ]);
  });

  it("keeps all catalog cases when a custom cases path is explicitly provided", () => {
    const catalogCases = [
      createCase("career_motivation_benefits_infographic_submission"),
      createCase("insurance_claim_status_check"),
      createCase("bilibili_learning_and_notes"),
    ];

    const selected = selectE2eAnalyzeCases({
      catalogCases,
      hasExplicitCasesPath: true,
    });

    expect(selected.map((item) => item.id)).toEqual(
      catalogCases.map((item) => item.id),
    );
  });

  it("throws when a default baseline case is missing from the default catalog", () => {
    expect(() =>
      selectE2eAnalyzeCases({
        catalogCases: [createCase("bilibili_learning_and_notes")],
        hasExplicitCasesPath: false,
      }),
    ).toThrow(
      "Default e2e-analyze cases are missing from catalog: insurance_claim_status_check",
    );
  });
});
