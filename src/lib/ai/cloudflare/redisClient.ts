import { AdmissionStoreError } from "./admissionStore";

export interface PoolRedisClient {
  sendCommand(args: readonly string[]): Promise<unknown>;
  close(): Promise<void>;
}

export function redisEndpointIdentity(address: string) {
  const url = new URL(address);
  if (!["redis:", "rediss:"].includes(url.protocol)) throw new AdmissionStoreError("invalid_store_input");
  return `${url.hostname.toLowerCase()}:${url.port || "6379"}`;
}

export class PoolRedisNoScriptError extends Error {
  readonly code = "NOSCRIPT";
  constructor() { super("NOSCRIPT"); this.name = "PoolRedisNoScriptError"; }
}

export function isNoScriptError(error: unknown) {
  return error instanceof PoolRedisNoScriptError || (error instanceof Error && /^NOSCRIPT\b/.test(error.message));
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, expire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expire(); reject(new AdmissionStoreError()); }, timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Connect only when explicitly called by the enabled pool's lazy runtime. */
export async function createRedisClient(
  url: string,
  options: { connectTimeoutMs?: number; commandTimeoutMs?: number } = {},
): Promise<PoolRedisClient> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 1_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 1_000;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new AdmissionStoreError("invalid_store_input"); }
  if (!["redis:", "rediss:"].includes(parsed.protocol) || ![connectTimeoutMs, commandTimeoutMs].every((value) =>
    Number.isInteger(value) && value >= 1 && value <= 10_000)) throw new AdmissionStoreError("invalid_store_input");
  const { createClient } = await import("redis");
  const client = createClient({
    url,
    socket: { connectTimeout: connectTimeoutMs, reconnectStrategy: false },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1_000,
  });
  // Raw Redis errors can contain host names or credentials. The facade logs a safe reason.
  client.on("error", () => {});
  const destroy = () => { if (client.isOpen) client.destroy(); };
  try { await bounded(client.connect(), connectTimeoutMs, destroy); }
  catch { destroy(); throw new AdmissionStoreError(); }
  return {
    async sendCommand(args) {
      try { return await bounded(client.sendCommand([...args]), commandTimeoutMs, destroy); }
      catch (error) {
        if (isNoScriptError(error)) throw new PoolRedisNoScriptError();
        throw new AdmissionStoreError();
      }
    },
    async close() { destroy(); },
  };
}
