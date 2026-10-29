import { randomUUID } from "node:crypto";
import { acquireLegacyExecution } from "./runtime";
import { isPoolFailure, networkFault, PoolError, ProviderFault, providerFaultFromResponse, publicPoolError } from "./providerError";
import type { CloudflareTask } from "./types";

type Metadata = { task: CloudflareTask; model: string; timeoutMs: number; stream?: boolean };
type Runtime = { acquireLegacyExecution: typeof acquireLegacyExecution };

/** Only inference calls use this transport. Storage downloads do not consume AI quota. */
export function createLegacyCloudflareFetch(runtime: Runtime = { acquireLegacyExecution }) {
  return async (url: string, init: RequestInit, metadata: Metadata): Promise<Response> => {
    const stage = metadata.task === "text" ? "text_translation" : metadata.task;
    let handle: Awaited<ReturnType<typeof acquireLegacyExecution>>;
    try {
      handle = await runtime.acquireLegacyExecution({ requestId: `legacy-${randomUUID()}`, task: metadata.task,
        timeoutMs: metadata.timeoutMs, signal: init.signal ?? undefined,
        telemetry: (event, fields) => console.info(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event, ...fields })) });
    } catch (error) { throw publicPoolError(error, stage); }
    if (!handle) return fetch(url, init);

    // Return streamed headers promptly, while execute() owns the permit until
    // EOF, cancellation or deadline. JSON is fully buffered inside the permit.
    let resolveResponse!: (response: Response) => void;
    let rejectResponse!: (error: unknown) => void;
    const available = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    let delivered = false;
    let rejectedResponse: Response | undefined;
    const execution = handle.execution;
    const dispatch = execution.dispatcher.execute({ context: execution, operation: `legacy_${metadata.task}`,
      model: metadata.model, timeoutMs: metadata.timeoutMs, accountIdentity: handle.accountIdentity }, async ({ account, signal }) => {
      const target = new URL(url);
      if (target.origin !== "https://api.cloudflare.com" ||
          !target.pathname.startsWith(`/client/v4/accounts/${account.accountId}/ai/`)) throw new PoolError("configuration");
      let response: Response | undefined;
      try {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${account.apiToken}`);
        response = await fetch(url, { ...init, headers, signal });
        if (!metadata.stream || !response.ok || !response.body) {
          const bytes = await response.arrayBuffer();
          const buffered = new Response(bytes.byteLength ? bytes : null, {
            status: response.status, statusText: response.statusText, headers: response.headers,
          });
          let payload: unknown;
          try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { payload = null; }
          if (!response.ok || payload && typeof payload === "object" && "success" in payload && payload.success === false) {
            rejectedResponse = buffered;
            throw providerFaultFromResponse(response, payload);
          }
          return buffered;
        }
        const reader = response.body.getReader();
        let finish!: () => void;
        let fail!: (error: unknown) => void;
        const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let settled = false;
        const stop = (error?: ProviderFault) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (error) { fail(error); void reader.cancel().catch(() => {}); }
          else finish();
        };
        const abort = () => {
          const error = networkFault(undefined, signal, response?.status);
          if (!settled) controller.error(publicPoolError(error, stage));
          stop(error);
        };
        const body = new ReadableStream<Uint8Array>({
          start(current) { controller = current; },
          async pull(current) {
            try {
              const item = await reader.read();
              if (settled) return;
              if (item.done) { current.close(); stop(); }
              else current.enqueue(item.value);
            } catch (error) {
              if (settled) return;
              const fault = networkFault(error, signal, response?.status);
              current.error(publicPoolError(fault, stage)); stop(fault);
            }
          },
          cancel() { stop(new ProviderFault("cancelled")); },
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else {
          delivered = true;
          resolveResponse(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
        }
        await finished;
        return response;
      } catch (error) {
        throw isPoolFailure(error) ? error : networkFault(error, signal, response?.status);
      }
    });
    void dispatch.then(response => {
      if (!delivered) resolveResponse(response);
    }, error => {
      // Keep legacy HTTP response contracts; the dispatcher has already applied
      // cooldown/credential policy. Admission and transport faults are typed.
      if (!delivered) {
        if (rejectedResponse && error instanceof ProviderFault) resolveResponse(rejectedResponse);
        else rejectResponse(publicPoolError(error, stage));
      }
    }).finally(handle.release);
    return available;
  };
}

export const fetchLegacyCloudflare = createLegacyCloudflareFetch();
