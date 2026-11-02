import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, rmdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiClient } from "./client.ts";
import { ConfigStore } from "./config.ts";
const HELP = `AI Session ChatRoom
  login
  room create --name NAME | room list | room repair-index --room ID
  invite create --room ID | invite accept | invite revoke ID --room ID
  member remove USER_ID --room ID
  session create --name NAME --room ID [--export-dir PATH] | session revoke ID
  send --session ID --room ID --message TEXT [--reply-to ID] [--request-id ID]
  read --session ID --room ID [--after N]
  wait --session ID --room ID [--timeout 30]
  ack --session ID --room ID --cursor N
Options: --base-url URL --config-dir PATH --json --stdin --help
AICHAT_TOKEN may supply a credential without storing it. JSON goes to stdout.
Use --stdin for message content or invite code. Never put tokens in command arguments.`;
async function input(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (Buffer.byteLength(value) > 32768) throw new Error("Input too large");
    }
    return value.trim();
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return (await terminal.question(prompt)).trim();
  } finally {
    terminal.close();
  }
}
export async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  output: (value: unknown) => void,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "base-url": { type: "string" },
      "config-dir": { type: "string" },
      session: { type: "string" },
      room: { type: "string" },
      name: { type: "string" },
      message: { type: "string" },
      "reply-to": { type: "string" },
      timeout: { type: "string" },
      after: { type: "string" },
      cursor: { type: "string" },
      "request-id": { type: "string" },
      "export-dir": { type: "string" },
      json: { type: "boolean" },
      stdin: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0) {
    output({ help: HELP });
    return;
  }
  const [command, action, target] = positionals;
  const base = (
    values["base-url"] ??
    env.AICHAT_BASE_URL ??
    "https://apiwx.net/chat/v1"
  ).replace(/\/$/, "");
  const store = new ConfigStore(
    values["config-dir"] ??
      env.AICHAT_CONFIG_DIR ??
      join(homedir(), ".config", "aichat"),
  );
  const required = (value: string | undefined, name: string) => {
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const number = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error("Invalid numeric argument");
    return Number(value);
  };
  const room = () => required(values.room, "--room"),
    session = () => required(values.session, "--session");
  const path = (id: string) => encodeURIComponent(id);
  if (command === "ack") {
    const cursor = number(required(values.cursor, "--cursor"), 0);
    await store.ack(base, session(), room(), cursor);
    output({ ok: true, cursor });
    return;
  }
  if (command === "login") {
    const client = new ApiClient(base, "");
    const started = await client.request<{
      login_secret: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>("/auth/device/start", "POST", {});
    process.stderr.write(
      `Open ${started.verification_uri} and enter ${started.user_code}\n`,
    );
    const deadline = Date.now() + started.expires_in * 1000;
    let interval = started.interval;
    while (Date.now() < deadline) {
      await sleep(interval * 1000);
      const result = await client.request<{
        status: string;
        interval?: number;
        token?: string;
        id?: string;
        user_id?: string;
        name?: string;
      }>(
        "/auth/device/poll",
        "POST",
        { login_secret: started.login_secret },
        true,
      );
      if (result.status === "complete" && result.token && result.id) {
        await store.saveCredential(base, result.id, result.token, "management");
        output({ ok: true, user_id: result.user_id, name: result.name });
        return;
      }
      if (
        result.status === "authorization_pending" ||
        result.status === "slow_down"
      ) {
        interval = result.interval ?? interval;
        continue;
      }
      throw new Error(`Login ${result.status}`);
    }
    throw new Error("Login expired; run login again");
  }
  const token =
    env.AICHAT_TOKEN ??
    (await store.token(base, values.session ?? "management"));
  const client = new ApiClient(base, token);
  if (command === "room" && action === "create") {
    output(
      await client.request(
        "/rooms",
        "POST",
        {
          name: required(values.name, "--name"),
          request_id: values["request-id"] ?? crypto.randomUUID(),
        },
        true,
      ),
    );
    return;
  }
  if (command === "room" && action === "repair-index") {
    const roomId = room();
    let after = "",
      indexed = 0;
    for (;;) {
      const page = await client.request<{
        indexed: number;
        next_cursor: string;
        has_more: boolean;
      }>(`/rooms/${path(roomId)}/repair-index`, "POST", { after }, true);
      indexed += page.indexed;
      if (!page.has_more) break;
      if (page.next_cursor <= after) throw new Error("Invalid repair cursor");
      after = page.next_cursor;
    }
    output({ ok: true, room_id: roomId, indexed });
    return;
  }
  if (command === "room" && action === "list") {
    output(await client.request("/rooms"));
    return;
  }
  if (command === "invite" && action === "create") {
    output(await client.request(`/rooms/${path(room())}/invites`, "POST", {}));
    return;
  }
  if (command === "invite" && action === "accept") {
    output(
      await client.request(
        "/invites/accept",
        "POST",
        { code: await input("Invite code: ") },
        true,
      ),
    );
    return;
  }
  if (command === "invite" && action === "revoke") {
    output(
      await client.request(
        `/rooms/${path(room())}/invites/${path(required(target, "invite ID"))}`,
        "DELETE",
        undefined,
        true,
      ),
    );
    return;
  }
  if (command === "member" && action === "remove") {
    output(
      await client.request(
        `/rooms/${path(room())}/members/${path(required(target, "user ID"))}`,
        "DELETE",
        undefined,
        true,
      ),
    );
    return;
  }
  if (command === "session" && action === "create") {
    const name = required(values.name, "--name"),
      roomId = room();
    const exportDir = values["export-dir"];
    if (exportDir) {
      await mkdir(dirname(exportDir), { recursive: true, mode: 0o700 });
      try {
        await mkdir(exportDir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("Export requires a new directory");
        throw error;
      }
    }
    try {
      const result = await client.request<{
        id: string;
        token: string;
        expiresAt: number;
      }>("/sessions", "POST", {
        name,
        rooms: [roomId],
      });
      await store.saveCredential(base, result.id, result.token, "session");
      if (values["export-dir"])
        await new ConfigStore(values["export-dir"]).saveCredential(
          base,
          result.id,
          result.token,
          "session",
        );
      output({
        id: result.id,
        expires_at: result.expiresAt,
        ...(values["export-dir"] ? { config_dir: values["export-dir"] } : {}),
      });
      return;
    } catch (error) {
      // Only remove a directory we created if it is still empty.
      if (exportDir) await rmdir(exportDir).catch(() => {});
      throw error;
    }
  }
  if (command === "session" && action === "revoke") {
    const id = required(target, "session ID");
    output(
      await client.request(`/sessions/${path(id)}`, "DELETE", undefined, true),
    );
    await store.forget(base, id);
    return;
  }
  if (command === "send") {
    session();
    const content = values.stdin
      ? await input("Message: ")
      : required(values.message, "--message or --stdin");
    output(
      await client.request(
        `/rooms/${path(room())}/messages`,
        "POST",
        {
          body: content,
          client_message_id: values["request-id"] ?? crypto.randomUUID(),
          ...(values["reply-to"] ? { reply_to: values["reply-to"] } : {}),
        },
        true,
      ),
    );
    return;
  }
  if (command === "read" || command === "wait") {
    const after = number(
      values.after,
      await store.cursor(base, session(), room()),
    );
    const wait = command === "wait" ? number(values.timeout, 30) : 0;
    if (wait > 30) throw new Error("Timeout must be between 0 and 30");
    output(
      await client.request(
        `/rooms/${path(room())}/messages?after=${after}&limit=100&wait=${wait}`,
      ),
    );
    return;
  }
  throw new Error("Unknown command; use --help");
}
