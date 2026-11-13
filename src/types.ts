export type Backend = "traex" | "codex";
export interface ModelProfile {
  model?: string;
  effort?: string;
}
export interface ReviewModelProfile extends ModelProfile {
  modelDefaultEffort?: boolean;
}
export interface AgentModel {
  id: string;
  model: string;
  displayName: string;
  isDefault?: boolean;
  defaultEffort?: string;
  efforts: { effort: string; description: string }[];
}
export type Side = "old" | "new";
export interface Target {
  provider: "codebase" | "github";
  host: string;
  repo: string;
  number: number;
  url: string;
}
export interface FileDiff {
  path: string;
  oldPath: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
  added: number;
  deleted: number;
}
export interface Comment {
  id: string;
  body: string;
  author: string;
  threadId?: string;
  path?: string;
  side?: Side;
  line?: number;
  outdated?: boolean;
  url?: string;
}
export interface Snapshot {
  id: string;
  target: Target;
  title: string;
  description: string;
  head: string;
  base: string;
  targetHead?: string;
  ownership?: Ownership;
  remoteVersion: string;
  repoId: string;
  mrId: string;
  files: FileDiff[];
  comments: Comment[];
  fetchedAt: string;
}
export interface Review {
  id: string;
  identity: string;
  target: Target;
  title: string;
  backend: Backend;
  backendOverride?: Backend;
  agentOverrides?: Partial<Record<Backend, ReviewModelProfile>>;
  versionId: string;
  explanationId?: string;
  createdAt: string;
}
export interface Source {
  id: string;
  versionId: string;
  path: string;
  side: Side;
  commit: string;
  content: string;
}
export interface Reference {
  id: string;
  path: string;
  side: Side;
  start: number;
  end: number;
  commit: string;
  sourceId: string;
  versionId?: string;
}
export interface Explanation {
  id: string;
  reviewId: string;
  versionId: string;
  title: string;
  summary: string;
  html: string;
  references: Reference[];
  guide?: ChangeGuide;
  ownership?: Ownership;
  writingStyle?: WritingStyle;
  backend: Backend;
  model: string;
  effort?: string;
  cliVersion: string;
  threadId: string;
  createdAt: string;
}
export interface ChangePoint {
  id: string;
  title: string;
  summary: string;
  before: string;
  after: string;
  rationale: string;
  risks: string[];
  files: string[];
  referenceIds: string[];
}
export interface ChangeGroup {
  id: string;
  title: string;
  category: string;
  summary: string;
  responsibility?: string;
  reviewFocus?: string[];
  context?: { group: number; reason: string; referenceIds: string[] }[];
  points: ChangePoint[];
}
export interface ChangeGuide {
  groups: ChangeGroup[];
}
export interface OwnershipRule {
  id: string;
  path: string;
  revision: string;
  owners: string[];
  pattern?: string;
  line?: number;
  approvalsRequired?: number;
}
export interface Ownership {
  versionId: string;
  provider: Target["provider"];
  capturedAt: string;
  status: "complete" | "partial" | "unavailable";
  rules: OwnershipRule[];
  files: {
    path: string;
    side: Side;
    owners: string[];
    ruleIds: string[];
    status: "resolved" | "unowned" | "unknown";
  }[];
  warnings: string[];
}
export interface Run {
  id: string;
  reviewId: string;
  versionId: string;
  kind: "analysis" | "question";
  state:
    "running" | "awaiting_approval" | "succeeded" | "failed" | "interrupted";
  backend: Backend;
  model?: string;
  effort?: string;
  requestedProfile?: ModelProfile;
  connectionRevision?: string;
  cliVersion?: string;
  threadId?: string;
  turnId?: string;
  eventSeq?: number;
  progress?: RunProgress;
  activity?: RunProgress[];
  usage?: RunUsage;
  usageUnavailableReason?: string;
  writingStyle?: WritingStyle;
  ownership?: Ownership;
  question?: string;
  context?: Reference;
  explanationId?: string;
  answer?: string;
  error?: string;
  errorCode?: string;
  createdAt: string;
  finishedAt?: string;
}
export interface WritingStyle {
  name: string;
  source: string;
  revision: string;
  sha256: string;
}
export interface ActiveOperation {
  id: string;
  reviewId: string;
  title: string;
  kind: Run["kind"];
  state: Run["state"];
  backend: Backend;
  model?: string;
  stopping: boolean;
}
export interface RunProgress {
  stage:
    "starting" | "investigating" | "thinking" | "generating" | "validating";
  message: string;
  at: string;
  source?: "agent" | "host";
  outputChars?: number;
  toolCalls?: number;
  filesRead?: number;
  savedParts?: number;
  savedChars?: number;
}
export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}
export interface RunUsage extends TokenCounts {
  source: "app-server";
  scope: "run";
  updatedAt: string;
}
export interface Draft {
  id: string;
  reviewId: string;
  versionId: string;
  body: string;
  anchor?: Reference;
  state: "draft" | "publishing" | "published" | "unknown";
  revision: number;
  publicationId?: string;
  remoteId?: string;
  error?: string;
  createdAt: string;
}
export interface ExecutionRequest {
  command: string;
  cwd: string;
  purpose: string;
  sideEffects: string;
  network: boolean;
  timeoutSeconds: number;
}
export interface Approval {
  id: string;
  runId: string;
  reviewId: string;
  versionId: string;
  request: ExecutionRequest;
  digest: string;
  state: "pending" | "approved" | "denied" | "finished" | "interrupted";
  error?: string;
  receipt?: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  };
  createdAt: string;
}
export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface ConfigApplication {
  state: "applied" | "pending" | "applying" | "failed" | "unavailable";
  desiredRevision?: string;
  appliedRevision?: string;
  activeOperations?: number;
  error?: string;
}
