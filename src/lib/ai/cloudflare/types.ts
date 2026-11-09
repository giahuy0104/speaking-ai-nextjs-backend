export type CloudflareOperation =
  | "audio_translation_asr"
  | "audio_translation_text"
  | "legacy_asr"
  | "legacy_text"
  | "legacy_tts";

export type CloudflareTask = "asr" | "text" | "tts";

export type RateLimit = Readonly<{
  rpm: number;
  burst: number;
  maxConcurrent: number;
}>;

export type CloudflareAccount = Readonly<{
  alias: string;
  accountId: string;
  identity: string;
  apiToken: string;
  enabled: boolean;
  capabilities: Readonly<{ asr: readonly string[]; text: readonly string[]; tts?: readonly string[] }>;
  limits: Readonly<{
    asr: RateLimit;
    text: RateLimit;
    tts?: RateLimit;
    accountMaxConcurrent: number;
    models?: Readonly<Record<string, RateLimit>>;
  }>;
}>;

export type QuotaRule = Readonly<{
  key: string;
  rpm?: number;
  burst?: number;
  maxConcurrent: number;
}>;

export type Permit = Readonly<{
  id: string;
  accountIdentity: string;
  ruleKeys: readonly string[];
  expiresAt: number;
  probe: boolean;
}>;

export type AdmissionResult =
  | { granted: true; permit: Permit }
  | { granted: false; retryAfterMs: number };

export type AdmissionOutcome = Readonly<{
  cooldownMs?: number;
  scopeKeys?: readonly string[];
  disable?: boolean;
}>;

export type AdmissionAcquireInput = Readonly<{
  accountIdentity: string;
  rules: readonly QuotaRule[];
  leaseId: string;
  ttlMs: number;
}>;

export type AccountSnapshot = { active: number; retryAfterMs: number };

export interface AdmissionStore {
  acquire(input: AdmissionAcquireInput): Promise<AdmissionResult>;
  complete(permit: Permit, outcome: AdmissionOutcome): Promise<void>;
  snapshot(
    accountIdentity: string,
    rules: readonly QuotaRule[],
  ): Promise<AccountSnapshot>;
  close?(): Promise<void>;
}

export type AttemptBudget = { used: number; max: number };

export type CloudflareExecutionContext = Readonly<{
  requestId: string;
  parentRequestId?: string;
  workload: "audio-translate" | "legacy-asr" | "legacy-text" | "legacy-tts";
  deadlineAt: number;
  signal: AbortSignal;
  attempts: AttemptBudget;
  /** Shared by request admission and both stages; waiting never resets the deadline. */
  admissionWait?: { usedMs: number };
  dispatcher: CloudflareDispatcher;
}>;

export interface CloudflareDispatcher {
  execute<T>(
    input: {
      context: CloudflareExecutionContext;
      operation: CloudflareOperation;
      model: string;
      timeoutMs?: number;
      /** Legacy callers retain their account while sharing its Redis quotas. */
      accountIdentity?: string;
    },
    callback: (input: {
      account: CloudflareAccount;
      signal: AbortSignal;
    }) => Promise<T>,
  ): Promise<T>;
}

export type PoolConfig = Readonly<{
  textBacklogThreshold?: number;
  legacyAccountIdentity?: string;
  routeLegacyAccount?: boolean;
  accounts: readonly CloudflareAccount[];
  store: "memory" | "redis";
  redisUrl?: string;
  namespace: string;
  configVersion: string;
  maxAttemptsPerStage: number;
  maxAttemptsPerRequest: number;
  maxWaitMs: number;
  maxInFlight: number;
  maxQueued: number;
  maxBufferedBytes: number;
  minAttemptMs: number;
}>;
