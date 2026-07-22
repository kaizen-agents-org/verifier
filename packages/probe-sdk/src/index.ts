export type TargetType =
  | "cli"
  | "api"
  | "web"
  | "electron"
  | "tauri"
  | "macos-native"
  | "windows-native"
  | "tui"
  | "mobile";

export interface ProbeDriver {
  readonly targetType: TargetType;
  detect(ctx: ProjectContext): Promise<DetectResult | null>;
  launch(ctx: LaunchContext): Promise<ProbeSession>;
}

export interface ProjectContext {
  rootDir: string;
  packageJson?: Record<string, unknown>;
  files: (glob: string) => Promise<string[]>;
  config?: ProbeConfig;
}

export interface DetectResult {
  confidence: number;
  launchHint: string;
}

export interface LaunchContext {
  workdir: string;
  env: Record<string, string>;
  ports: PortAllocator;
  timeoutMs: number;
  networkPolicy: NetworkPolicy;
}

export class LaunchError extends Error {
  readonly cause?: unknown;
  readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message);
    this.name = "LaunchError";
    this.cause = options?.cause;
    this.retryable = options?.retryable ?? false;
  }
}

export interface ProbeSession {
  interact(scenario: Scenario): Promise<StepResult[]>;
  observe(): Promise<Observation>;
  teardown(): Promise<void>;
}

export interface Scenario {
  id: string;
  description: string;
  claimIds: string[];
  failCategory?: "security" | "data-loss" | "crash" | "regression" | "logic" | "perf";
  steps: Step[];
}

export type Step =
  | { op: "navigate"; url: string }
  | { op: "click"; target: string }
  | { op: "type"; target: string; text: string }
  | { op: "key"; keys: string }
  | { op: "exec"; command: string; stdin?: string }
  | {
      op: "request";
      method: string;
      path: string;
      body?: unknown;
      headers?: Record<string, string>;
      expect?: RequestExpectation;
    }
  | { op: "wait"; forMs?: number; until?: string }
  | { op: "assert-screen"; naturalLanguage: string };

export interface RequestExpectation {
  status?: number;
  statusAnyOf?: number[];
  jsonSchema?: unknown;
  bodyIncludes?: string;
  headers?: Record<string, string>;
}

export function validateRequestExpectation(
  expectation: RequestExpectation | undefined
): string | undefined {
  if (!expectation) return undefined;
  if (expectation.status !== undefined && expectation.statusAnyOf !== undefined) {
    return "Request expectation cannot specify both status and statusAnyOf.";
  }
  if (expectation.statusAnyOf?.length === 0) {
    return "Request expectation statusAnyOf must contain at least one status.";
  }
  return undefined;
}

export class UnsupportedStepError extends Error {
  readonly cause?: unknown;
  readonly retryable: boolean;
  readonly step: Step;

  constructor(step: Step, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message);
    this.name = "UnsupportedStepError";
    this.step = step;
    this.cause = options?.cause;
    this.retryable = options?.retryable ?? false;
  }
}

export interface Observation {
  consoleErrors: LogEntry[];
  networkFailures: NetworkEntry[];
  screenshots: Artifact[];
  perf?: PerfMetrics;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  crashed: boolean;
  artifacts: Artifact[];
}

export interface StepResult {
  stepIndex: number;
  ok: boolean;
  error?: string;
  artifacts: Artifact[];
}

export interface Artifact {
  kind: "screenshot" | "har" | "trace" | "log" | "file";
  path: string;
}

export interface LogEntry {
  level: "error" | "warn";
  text: string;
  source?: string;
  timestamp: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  failed: boolean;
}

export interface PerfMetrics {
  lcpMs?: number;
  inpMs?: number;
  raw?: Artifact;
}

export interface PortAllocator {
  acquire(): Promise<number>;
  release(port: number): void;
}

export interface NetworkPolicy {
  allowedHosts: string[];
}

export interface ProbeConfig {
  launch?: string;
  readyWhen?: string;
  port?: number;
  scenarios?: Scenario[];
}
