export function isDatabaseTransferQuotaError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const input = error as Record<string, unknown>;
  const message = [input.message, input.detail, input.cause]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const status = Number(input.status ?? input.statusCode);

  return (
    (status === 402 || message.includes("http status 402")) &&
    message.includes("data transfer quota")
  );
}
