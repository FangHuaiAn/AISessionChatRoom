const statuses: Record<string, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_invite: 400,
  payload_too_large: 413,
  rate_limited: 429,
  not_configured: 503,
  request_cancelled: 499,
};
export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  const code = Object.hasOwn(statuses, message) ? message : "internal_error";
  const response = json({ error: { code } }, statuses[code] ?? 500);
  if (code === "rate_limited") response.headers.set("Retry-After", "60");
  return response;
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new Error("bad_request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("bad_request");
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) throw new Error("payload_too_large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("bad_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("bad_request");
  return parsed as Record<string, unknown>;
}
export function string(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("bad_request");
  return value;
}
export function integer(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error("bad_request");
  return value;
}

export function segment(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("bad_request");
  }
  if (/[\/\x00-\x1f\x7f]/.test(decoded)) throw new Error("bad_request");
  return string(decoded);
}
