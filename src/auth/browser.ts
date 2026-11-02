export function sameOrigin(request: Request) {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin)
    throw new Error("forbidden");
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("forbidden");
}
export function cookieToken(request: Request): string | undefined {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("aichat_session="));
  if (matches.length !== 1) return undefined;
  const token = matches[0].slice("aichat_session=".length);
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export function sessionCookie(
  request: Request,
  token: string,
  clear = false,
): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `aichat_session=${token}; Path=/chat; HttpOnly; SameSite=Strict${secure}${clear ? "; Max-Age=0" : ""}`;
}
