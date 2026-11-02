import type { Maintenance } from "../src/maintenance";
import { failure, json } from "../src/http";
type OpsEnv = { CHAT: Service<Maintenance>; OPS_TOKEN: string };
export default {
  async fetch(request: Request, env: OpsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return json({ error: { code: "forbidden" } }, 403);
    if (
      !/^[a-f0-9]{64}$/.test(env.OPS_TOKEN ?? "") ||
      request.headers.get("Authorization") !== "Bearer " + env.OPS_TOKEN
    )
      return json({ error: { code: "unauthorized" } }, 401);
    if (
      request.headers.has("Origin") &&
      request.headers.get("Origin") !== url.origin
    )
      return json({ error: { code: "forbidden" } }, 403);
    if (url.pathname !== "/rpc" || request.method !== "POST")
      return json({ error: { code: "not_found" } }, 404);
    try {
      if (!request.headers.get("Content-Type")?.startsWith("application/json"))
        throw new Error("bad_request");
      const reader = request.body?.getReader();
      if (!reader) throw new Error("bad_request");
      let length = 0,
        text = "";
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 8 * 1024 * 1024) throw new Error("payload_too_large");
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      const { method, args } = JSON.parse(text);
      if (!Array.isArray(args)) throw new Error("bad_request");
      let result;
      switch (method) {
        case "registryHeader":
          result = await env.CHAT.registryHeader();
          break;
        case "registeredRooms":
          result = await env.CHAT.registeredRooms(args[0], args[1]);
          break;
        case "roomHeader":
          result = await env.CHAT.roomHeader(args[0]);
          break;
        case "roomPage":
          result = await env.CHAT.roomPage(args[0], args[1], args[2]);
          break;
        case "restoreBegin":
          result = await env.CHAT.restoreBegin(args[0]);
          break;
        case "restorePage":
          result = await env.CHAT.restorePage(
            args[0],
            args[1],
            args[2],
            args[3],
          );
          break;
        case "restoreFinish":
          result = await env.CHAT.restoreFinish(args[0], args[1]);
          break;
        default:
          throw new Error("not_found");
      }
      return json(result);
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<OpsEnv>;
