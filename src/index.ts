import { body, failure, integer, json, segment, string } from "./http";
import { hashToken } from "./auth/tokens";
export { Directory } from "./directory";
export { Room } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname,
        method = request.method;
      if (method === "GET" && path === "/chat/v1/health")
        return json({ status: "ok" });
      if (!path.startsWith("/chat/v1/")) throw new Error("not_found");
      const route = path.slice("/chat/v1".length);
      const directory = env.DIRECTORY.getByName("directory");
      if (
        method === "POST" &&
        (route === "/auth/device/start" || route === "/auth/device/poll")
      ) {
        if (!env.GITHUB_CLIENT_ID) throw new Error("not_configured");
        const input = await body(request);
        const key =
          "login:" +
          (await hashToken(request.headers.get("CF-Connecting-IP") ?? "local"));
        if (!(await directory.consumeLimit(key, 60, 60)))
          throw new Error("rate_limited");
        if (route.endsWith("/start"))
          return json(await directory.startLogin(env.GITHUB_CLIENT_ID), 201);
        return json(
          await directory.pollLogin(
            env.GITHUB_CLIENT_ID,
            string(input.login_secret, 64),
          ),
        );
      }
      const token = request.headers
        .get("Authorization")
        ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const principal = token ? await directory.authenticate(token) : null;
      if (!principal) throw new Error("unauthorized");
      if (!(await directory.consumeLimit("user:" + principal.userId, 300, 60)))
        throw new Error("rate_limited");
      const management = () => {
        if (principal.kind !== "management") throw new Error("forbidden");
      };
      if (route === "/rooms" && method === "POST") {
        management();
        const input = await body(request);
        const name = string(input.name);
        const requestId =
          input.request_id === undefined
            ? crypto.randomUUID()
            : string(input.request_id);
        const id = await hashToken(`room:${principal.userId}:${requestId}`);
        const room = await env.ROOMS.getByName(id).initialize(
          id,
          name,
          principal.userId,
        );
        await directory.recordRoom(principal.userId, id);
        return json(room, 201);
      }
      if (route === "/rooms" && method === "GET") {
        const ids =
          principal.kind === "session"
            ? principal.rooms
            : await directory.roomIds(principal.userId);
        const rooms = [];
        for (const id of ids) {
          try {
            rooms.push(await env.ROOMS.getByName(id).describe(principal));
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "not_found")
              throw error;
          }
        }
        return json({ rooms });
      }
      if (route === "/invites/accept" && method === "POST") {
        management();
        const input = await body(request),
          code = string(input.code, 256),
          id = code.split(".")[0];
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_invite");
        const room = await env.ROOMS.getByName(id).acceptInvite(
          code,
          principal.userId,
        );
        await directory.recordRoom(principal.userId, id);
        return json(room);
      }
      if (route === "/sessions" && method === "POST") {
        management();
        const input = await body(request),
          name = string(input.name);
        if (
          !Array.isArray(input.rooms) ||
          input.rooms.length === 0 ||
          input.rooms.length > 20
        )
          throw new Error("bad_request");
        const rooms = [...new Set(input.rooms.map((id) => string(id)))];
        for (const id of rooms)
          await env.ROOMS.getByName(id).describe(principal);
        const result = await directory.issueCredential({
          userId: principal.userId,
          kind: "session",
          name,
          rooms,
          ttl: integer(input.ttl, 60, 2592000, 86400),
        });
        return json(result, 201);
      }
      const session = route.match(/^\/sessions\/([^/]+)$/);
      if (session && method === "DELETE") {
        management();
        if (
          !(await directory.revokeCredential(
            principal.userId,
            segment(session[1]),
          ))
        )
          throw new Error("not_found");
        return json({ ok: true });
      }
      const messageRoute = route.match(/^\/rooms\/([^/]+)\/messages$/);
      if (messageRoute) {
        const room = env.ROOMS.getByName(segment(messageRoute[1]));
        if (method === "POST") {
          const input = await body(request);
          const message = await room.send(principal, {
            body: string(input.body, 16000),
            client_message_id: string(input.client_message_id),
            ...(input.reply_to === undefined
              ? {}
              : { reply_to: string(input.reply_to) }),
          });
          return json(message, 201);
        }
        if (method === "GET") {
          const query = (
            key: string,
            min: number,
            max: number,
            fallback: number,
          ) => {
            const raw = url.searchParams.get(key);
            if (raw !== null && !/^\d+$/.test(raw))
              throw new Error("bad_request");
            return integer(
              raw === null ? undefined : Number(raw),
              min,
              max,
              fallback,
            );
          };
          const after = query("after", 0, Number.MAX_SAFE_INTEGER, 0),
            limit = query("limit", 1, 100, 100),
            wait = query("wait", 0, 30, 0);
          const result = await room.waitForMessages(
            principal,
            after,
            limit,
            wait,
          );
          // Revocation can happen while a long poll is suspended.
          const fresh = await directory.authenticate(token!);
          if (!fresh) throw new Error("unauthorized");
          await room.describe(fresh);
          return json(result);
        }
      }
      const roomRoute = route.match(
        /^\/rooms\/([^/]+)(?:\/(invites|members)(?:\/([^/]+))?)?$/,
      );
      if (roomRoute) {
        const [, rawId, resource, rawTarget] = roomRoute;
        const id = segment(rawId),
          target = rawTarget === undefined ? undefined : segment(rawTarget);
        const room = env.ROOMS.getByName(id);
        if (!resource && method === "GET")
          return json(await room.describe(principal));
        if (resource === "invites" && !target && method === "POST")
          return json(await room.createInvite(principal), 201);
        if (resource === "invites" && target && method === "DELETE")
          return json(await room.revokeInvite(principal, target));
        if (resource === "members" && target && method === "DELETE")
          return json(await room.removeMember(principal, target));
      }
      throw new Error("not_found");
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Env>;
