export const UI_EVENT_TYPES = [
  "click",
  "move",
  "scroll",
  "key",
  "text",
  "app_switch",
  "window_focus",
  "clipboard",
] as const;
export type UiEventType = (typeof UI_EVENT_TYPES)[number];
export type EventType = UiEventType | "ocr" | "audio";
export interface RawRef {
  file: string;
  line: number;
}
export type NormalizedSource =
  | "ui-events"
  | "search-ocr"
  | "search-audio"
  | "search-input"
  | "search-ui"
  | "search-accessibility";
export interface NormalizedEvent {
  id: string;
  source: NormalizedSource;
  tsIso: string;
  tsMs: number;
  spanStartTsIso?: string | null;
  spanStartTsMs?: number | null;
  spanEndTsIso?: string | null;
  spanEndTsMs?: number | null;
  appName: string | null;
  windowName: string | null;
  eventType: EventType;
  textContent: string | null;
  x: number | null;
  y: number | null;
  keyCode: number | null;
  modifiers: number | null;
  browserUrl: string | null;
  frameId: number | null;
  deviceName?: string | null;
  speakerName?: string | null;
  rawRef: RawRef;
}
export interface Episode {
  id: string;
  runId: string;
  startTs: string;
  endTs: string;
  durationMs: number;
  eventsCount: number;
  events: NormalizedEvent[];
}
export interface ScreenpipeCapabilityMatrix {
  healthAvailable: boolean;
  uiEventsEndpoint: boolean;
  searchAudioContentType: boolean;
  searchInputContentType: boolean;
  searchAccessibilityContentType: boolean;
  searchUiContentType: boolean;
  searchAllContentType: boolean;
  chosenUiEventSource:
    | "ui-events"
    | "search-input"
    | "search-accessibility"
    | "search-ui"
    | "search-all"
    | "search-combined"
    | "none";
}
export interface SegmenterConfig {
  idleGapMs: number;
  appSwitchSplitGapMs: number;
  maxEpisodeMs: number;
  version: "segmenter_v1";
}
// EN: Skill granularity modes; only medium is supported for now, others are reserved for future work.
export type SkillGranularity = "medium" | "micro" | "macro";
// EN: Skill execution mode (autonomous only for now).
export type SkillExecutionMode = "autonomous";
// EN: Candidate workflow emitted by the workflow-discovery stage.
export interface WorkflowCandidate {
  workflowId: string;
  name: string;
  description: string;
  goal: string;
  priority: number;
  confidence?: number;
  startEventId: string;
  endEventId: string;
  startTs: string;
  endTs: string;
  eventCount: number;
  whyThisWorkflow?: string;
}
export interface RunManifest {
  runId: string;
  createdAt: string;
  status: "running" | "success" | "failed";
  args: {
    from: string;
    to: string;
    apps: string[] | "*";
    out: string;
    baseUrl: string;
  };
  paths: {
    runDir: string;
    rawUiEvents: string;
    rawOcr: string;
    rawAudio: string;
    normalizedEvents: string;
    episodes: string;
    summary: string;
  };
  capabilities: ScreenpipeCapabilityMatrix | null;
  segmenter: SegmenterConfig;
  warnings: string[];
  error: {
    message: string;
    stack?: string;
  } | null;
}
export interface IngestSummary {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  timeWindow: {
    requested: {
      startTs: string;
      endTs: string;
      durationMs: number;
    };
    observed: {
      startTs: string | null;
      endTs: string | null;
      durationMs: number;
    };
  };
  fetch: {
    ocrPages: number;
    audioPages: number;
    uiPages: number;
    rawOcrCount: number;
    rawAudioCount: number;
    rawUiEventsCount: number;
  };
  transform: {
    normalizedCount: number;
    dedupedCount: number;
    droppedDuplicates: number;
  };
  episodes: {
    count: number;
    avgDurationMs: number;
    medianDurationMs: number;
  };
  warnings: string[];
}
export interface PaginationInfo {
  limit: number;
  offset: number;
  total: number;
}
export interface SearchResponse {
  data: Array<{ type: string; content: Record<string, unknown> }>;
  pagination: PaginationInfo;
}
export interface UiEventsResponse {
  data: Array<Record<string, unknown>>;
  pagination: PaginationInfo;
}
export interface FrameOcrTextPosition {
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}
export interface FrameOcrResponse {
  frame_id?: number;
  text?: string;
  text_positions?: FrameOcrTextPosition[];
  [key: string]: unknown;
}
export interface HealthResponse {
  status?: string;
  status_code?: number;
  frame_status?: string;
  audio_status?: string;
  message?: string;
  [key: string]: unknown;
}
export interface RawEventWithRef {
  source: NormalizedSource;
  rawRef: RawRef;
  payload: Record<string, unknown>;
}
export interface OpenClawSkillStep {
  step: number;
  instruction: string;
  intent: string;
  operationApp: string;
  hints: string[];
}
export interface OpenClawSkillField {
  name: string;
  description: string;
  required?: boolean;
}
export type OpenClawSkillAssetValue =
  | string
  | string[]
  | Record<string, string>;
export interface OpenClawSkillAsset {
  name: string;
  value: OpenClawSkillAssetValue;
  notes?: string;
}
export interface OpenClawSkill {
  schemaVersion: "openclaw-skill-v1";
  promptSet: string | null;
  skillId: string;
  skillName: string;
  generatedAt: string;
  source: {
    runId: string;
    runDir: string;
    episodeId: string;
    startTs: string;
    endTs: string;
  };
  executionMode?: SkillExecutionMode;
  shortDescription?: string;
  description: string;
  goal: string;
  whenToUse: string[];
  whenNotToUse: string[];
  inputs: OpenClawSkillField[];
  outputs: OpenClawSkillField[];
  prerequisites: string[];
  steps: OpenClawSkillStep[];
  successCriteria: string[];
  failureModes: string[];
  fallback: string[];
  examples: string[];
  tags: string[];
  assets: OpenClawSkillAsset[];
  evidence: {
    totalEvents: number;
    anchorEvents: number;
    ocrEvents: number;
    appsSeen: string[];
    windowsSeen: string[];
  };
}
export interface LlmInvocationSummary {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalReactionTimeMs: number;
}
export interface PredictedReuseScenario {
  scenarioId: string;
  nextUseHypothesis: string;
}
export interface GeneralizedSkillVariantSummary {
  schemaVersion: "openclaw-generalized-skill-summary-v1";
  generatedAt: string;
  sourceSkillId: string;
  scenarioId: string;
  nextUseHypothesis: string;
  skillId: string;
  output: {
    outDir: string;
    skillPath: string;
    summaryPath: string;
  };
  llm?: LlmInvocationSummary;
  warnings: string[];
}
export interface SkillGeneralizationSummary {
  predictedScenariosPath: string | null;
  scenarioCount: number;
  variants: GeneralizedSkillVariantSummary[];
  llm?: LlmInvocationSummary;
  warnings: string[];
}
export interface SkillExtractionSummary {
  runId: string;
  episodeId: string;
  skillId: string;
  generatedAt: string;
  sourceEvents: number;
  stepsCount: number;
  workflowCandidates?: WorkflowCandidate[];
  selectedWorkflowId?: string | null;
  selectedWorkflowPriority?: number | null;
  llm?: LlmInvocationSummary;
  generalization?: SkillGeneralizationSummary;
  output: {
    outDir: string;
    skillPath: string;
    summaryPath: string;
  };
  warnings: string[];
}
export interface SkillQualityDimension {
  name: string;
  score: number;
  maxScore: number;
  reason: string;
}
export interface SkillQualityReport {
  schemaVersion: "openclaw-quality-v1";
  evaluatedAt: string;
  runId: string;
  episodeId: string;
  skillId: string;
  score: number;
  threshold: number;
  verdict: "usable" | "needs-improvement" | "poor";
  dimensions: SkillQualityDimension[];
  strengths: string[];
  issues: string[];
  improvements: string[];
  details: {
    warningsCount: number;
    stepsCount: number;
    genericStepCount: number;
    contextAnchoredStepCount: number;
    dominantApp: string | null;
    dominantAppStepCoverage: number;
    selectedWorkflowId?: string | null;
    selectedWorkflowPriority?: number | null;
    closureScore?: number;
    parameterHintCount?: number;
    parameterizationScore?: number;
    noiseRatio?: number;
    noiseScore?: number;
  };
}
