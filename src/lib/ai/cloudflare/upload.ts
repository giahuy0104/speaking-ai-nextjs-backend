import { AppError } from "../../appError";
import { abortError, withSignal } from "./deadline";
import { PoolError } from "./providerError";

/** Enforce the reserved wire-size limit even for chunked or dishonest uploads. */
export async function readBoundedAudioFormData(request: Request, maxBytes: number, signal: AbortSignal) {
  if (signal.aborted) throw abortError(signal);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("BAD_REQUEST", "Yêu cầu chưa có nội dung audio.");
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await withSignal(signal, () => reader.read());
        if (chunk.done) { controller.close(); return; }
        received += chunk.value.byteLength;
        if (received > maxBytes) throw new AppError("AUDIO_TOO_LONG", "Tệp audio vượt quá dung lượng cho phép.", 413);
        controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); }
    },
    cancel: () => reader.cancel().catch(() => {}),
  });
  try {
    const limited = new Request(request.url, {
      method: "POST", headers: { "Content-Type": request.headers.get("content-type") ?? "" },
      body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    return await withSignal(signal, () => limited.formData());
  } catch (error) {
    // Next's body stream can reject before the abort listener wins its race.
    // A disconnected caller must not be mislabeled as malformed multipart.
    if (signal.aborted) throw abortError(signal);
    if (error instanceof AppError || error instanceof PoolError) throw error;
    throw new AppError("BAD_REQUEST", "Nội dung multipart/form-data không hợp lệ.");
  } finally {
    // A client can stall forever inside read(); cancellation frees that reader.
    void reader.cancel().catch(() => {});
  }
}
