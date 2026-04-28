import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { getDefaultPromptsetDir } from "../io/project-paths.js";

const PROMPTSET_SCHEMA_VERSION = "oysterworkflow-promptset-v1";
const DEFAULT_PROMPTSET_DIR = getDefaultPromptsetDir();

const promptSetSectionSchema = z.object({
  system: z.array(z.string().min(1)),
  userPreamble: z.array(z.string().min(1)),
});

const promptSetFileSchema = z
  .object({
    schemaVersion: z.literal(PROMPTSET_SCHEMA_VERSION),
    promptSet: z.string().min(1),
    workflowDiscovery: promptSetSectionSchema.optional(),
    skillExtraction: promptSetSectionSchema,
    plannerOptimization: promptSetSectionSchema.optional(),
    scenarioPrediction: promptSetSectionSchema.optional(),
    scenarioGeneralization: promptSetSectionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.workflowDiscovery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Prompt set must define workflowDiscovery.",
        path: ["workflowDiscovery"],
      });
    }
  });

export type PromptSetFile = z.infer<typeof promptSetFileSchema>;

export interface LoadedPromptSet {
  schemaVersion: typeof PROMPTSET_SCHEMA_VERSION;
  promptSet: string;
  workflowDiscovery: z.infer<typeof promptSetSectionSchema>;
  skillExtraction: z.infer<typeof promptSetSectionSchema>;
  plannerOptimization?: z.infer<typeof promptSetSectionSchema>;
  scenarioPrediction?: z.infer<typeof promptSetSectionSchema>;
  scenarioGeneralization?: z.infer<typeof promptSetSectionSchema>;
  filePath: string;
}

/**
 * EN: Loads and validates a prompt set file.
 * @param promptSet promptSet identifier.
 * @param baseDir prompt set root directory.
 * @returns loaded prompt set with file path.
 */
export async function loadPromptSet(
  promptSet: string,
  baseDir?: string,
): Promise<LoadedPromptSet> {
  const rootDir = resolve(baseDir ?? DEFAULT_PROMPTSET_DIR);
  const filePath = resolve(rootDir, `${promptSet}.json`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read prompt set file at ${filePath}: ${toErrorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in prompt set file at ${filePath}: ${toErrorMessage(error)}`,
    );
  }

  const validated = promptSetFileSchema.parse(parsed);
  if (validated.promptSet !== promptSet) {
    throw new Error(
      `Prompt set mismatch: expected ${promptSet}, got ${validated.promptSet} in ${filePath}`,
    );
  }

  if (!validated.workflowDiscovery) {
    throw new Error(
      `Prompt set ${promptSet} must define workflowDiscovery in ${filePath}`,
    );
  }

  return {
    schemaVersion: validated.schemaVersion,
    promptSet: validated.promptSet,
    workflowDiscovery: validated.workflowDiscovery,
    skillExtraction: validated.skillExtraction,
    ...(validated.plannerOptimization
      ? { plannerOptimization: validated.plannerOptimization }
      : {}),
    ...(validated.scenarioPrediction
      ? { scenarioPrediction: validated.scenarioPrediction }
      : {}),
    ...(validated.scenarioGeneralization
      ? { scenarioGeneralization: validated.scenarioGeneralization }
      : {}),
    filePath,
  };
}

/**
 * EN: Renders prompt template lines and checks unresolved placeholders.
 * @param lines template lines.
 * @param vars placeholder variables.
 * @returns rendered prompt text.
 */
export function renderPromptTemplate(
  lines: string[],
  vars: Record<string, string>,
): string {
  let rendered = lines.join("\n");
  for (const [key, value] of Object.entries(vars)) {
    rendered = rendered.split(`{{${key}}}`).join(value);
  }

  const unresolved = Array.from(rendered.matchAll(/{{\s*([^}]+)\s*}}/g))
    .map((match) => match[1].trim())
    .filter((token) => token !== "...");
  if (unresolved.length > 0) {
    throw new Error(`Unresolved prompt placeholders: ${unresolved.join(", ")}`);
  }

  return rendered;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
