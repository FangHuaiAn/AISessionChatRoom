import { setTimeout as delay } from "node:timers/promises";
export class ApiClient {
  readonly base: string;
  private token: string;
  private sleep: (ms: number) => Promise<void>;
  constructor(
    base: string,
    token: string,
    sleep: (ms: number) => Promise<void> = async (ms) => {
      await delay(ms);
    },
  ) {
    const url = new URL(base);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("HTTPS is required except for localhost");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Invalid API base URL");
    this.base = base.replace(/\/$/, "");
    this.token = token;
    this.sleep = sleep;
  }
  async request<T = unknown>(
    path: string,
    method = "GET",
    body?: unknown,
    retry = method === "GET",
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid API path");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.base + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: payload,
          signal: AbortSignal.timeout(45000),
          redirect: "error",
        });
      } catch {
        if (retry && attempt < 2) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        throw new Error("Network request failed");
      }
      if (
        retry &&
        attempt < 2 &&
        (response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel().catch(() => {});
        const seconds = Number(response.headers.get("Retry-After"));
        await this.sleep(
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds, 60) * 1000
            : 250 * 2 ** attempt,
        );
        continue;
      }
      let result: { error?: { code?: string } };
      try {
        result = (await response.json()) as typeof result;
      } catch {
        if (response.ok && retry && attempt < 2) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        throw new Error(
          response.ok ? "Network response failed" : `HTTP ${response.status}`,
        );
      }
      if (!response.ok) {
        const code = result?.error?.code;
        throw new Error(
          typeof code === "string" && /^[a-z_]+$/.test(code)
            ? code
            : `HTTP ${response.status}`,
        );
      }
      return result as T;
    }
    throw new Error("Retry limit reached");
  }
}
