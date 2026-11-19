/**
 * Byte-range responses for finished audio. iOS's AVPlayer opens every HTTP source
 * with a `Range: bytes=0-1` probe and only plays a response that answers it with
 * 206 + Content-Range (so it knows the total length); a live chunked stream with no
 * length fails with AVFoundationErrorDomain -11850. Shared by /api/audio/cache and
 * the finished-audio path of /api/audio/target.
 */

export type AudioByteRange = { start: number; end: number };

export function parseByteRange(
  rangeHeader: string | null,
  totalBytes: number,
): AudioByteRange | null | "invalid" {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || totalBytes <= 0) return "invalid";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, totalBytes - suffixLength), end: totalBytes - 1 };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : totalBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= totalBytes
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, totalBytes - 1) };
}

/** A range with an explicit end (AVPlayer's `bytes=0-1` probe), not an open `bytes=0-` read. */
export function isBoundedRangeRequest(rangeHeader: string | null): boolean {
  return rangeHeader !== null && /^bytes=\d+-\d+$/i.test(rangeHeader.trim());
}

/** 206 for a satisfiable range, 416 for an unsatisfiable one, else 200 with the whole file. */
export function rangedAudioResponse(
  audio: Uint8Array,
  rangeHeader: string | null,
  baseHeaders: HeadersInit,
  includeBody = true,
): Response {
  const headers = new Headers(baseHeaders);
  headers.set("Accept-Ranges", "bytes");
  const range = parseByteRange(rangeHeader, audio.byteLength);

  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${audio.byteLength}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  if (range) {
    const body = audio.subarray(range.start, range.end + 1);
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${audio.byteLength}`);
    headers.set("Content-Length", String(body.byteLength));
    return new Response(includeBody ? new Uint8Array(body) : null, { status: 206, headers });
  }

  headers.set("Content-Length", String(audio.byteLength));
  return new Response(includeBody ? new Uint8Array(audio) : null, { status: 200, headers });
}
