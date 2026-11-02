import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, test, vi } from "vitest";

const html = readFileSync("public/chat/index.html", "utf8");
const script = readFileSync("public/chat/app.js", "utf8");
const windows: JSDOM[] = [];
const alice = { userId: "github:1", name: "Alice", kind: "management" };
const room = { id: "room-a", name: "Private room", owner_id: alice.userId };
const message = {
  id: "msg-a",
  seq: 1,
  user_id: alice.userId,
  session_id: "session-a",
  body: "<img src=x onerror=alert(1)>",
  created_at: Date.now(),
};
function setup(
  override?: (path: string, options: any) => Promise<Response> | undefined,
) {
  const dom = new JSDOM(html, {
    url: "http://localhost:8787/chat/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  windows.push(dom);
  const w = dom.window;
  const fetch = vi.fn(async (url: string, options: any) => {
    const path = url.replace("/chat/v1", "");
    const custom = override?.(path, options);
    if (custom) return custom;
    let body: any = {};
    if (path === "/auth/me") body = alice;
    else if (path === "/rooms") body = { rooms: [room] };
    else if (path.startsWith("/sessions?"))
      body = { sessions: [], next_cursor: "", has_more: false };
    else if (path.endsWith("/members"))
      body = { members: [{ user_id: alice.userId, role: "owner" }] };
    else if (path.includes("/messages?")) {
      if (path.includes("after=1"))
        return new Promise<Response>((_, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        );
      body = { messages: [message], next_cursor: 1, has_more: false };
    }
    return Response.json(body);
  });
  w.fetch = fetch as any;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  w.eval(script);
  const get = (id: string) => w.document.getElementById(id) as any;
  const select = async () => {
    await vi.waitFor(() =>
      expect(get("rooms").querySelector("button")).not.toBeNull(),
    );
    get("rooms").querySelector("button").click();
    await vi.waitFor(() =>
      expect(get("messages").textContent).toContain(message.body),
    );
  };
  return { w, get, fetch, select };
}
afterEach(() => {
  for (const dom of windows.splice(0)) {
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    dom.window.close();
  }
});

test("renders external message content as text and reuses the message ID after a failed send", async () => {
  let attempts = 0;
  const app = setup((path, options) =>
    path.endsWith("/messages") && options.method === "POST"
      ? ++attempts === 1
        ? Promise.reject(new Error("network"))
        : Promise.resolve(Response.json({}))
      : undefined,
  );
  await app.select();
  expect(app.get("messages").querySelector("img")).toBeNull();
  app.get("message").value = "hello";
  app
    .get("compose")
    .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(app.get("send").disabled).toBe(false));
  app
    .get("compose")
    .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(app.get("message").value).toBe(""));
  const requests = app.fetch.mock.calls
    .filter(([, options]) => options.method === "POST")
    .map(([, options]) => JSON.parse(options.body));
  expect(requests).toHaveLength(2);
  expect(requests[0].client_message_id).toBe(requests[1].client_message_id);
});

test("logout clears private history, drafts, and open secret dialogs", async () => {
  const app = setup();
  await app.select();
  app.get("message").value = "private draft";
  app.get("secret-value").value = "private-token";
  app.get("secret-dialog").showModal();
  app.get("logout").click();
  await vi.waitFor(() => expect(app.get("workspace").hidden).toBe(true));
  expect(app.get("messages").textContent).toBe("");
  expect(app.get("message").value).toBe("");
  expect(app.get("secret-value").value).toBe("");
  expect(app.get("secret-dialog").open).toBe(false);
  expect(app.get("compose").hidden).toBe(true);
  expect(app.get("room-title").textContent).toBe("選擇聊天室");
});

test("a successful send does not erase edits made while the request is in flight", async () => {
  let complete!: (value: Response) => void;
  const app = setup((path, options) =>
    path.endsWith("/messages") && options.method === "POST"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : undefined,
  );
  await app.select();
  app.get("message").value = "first";
  app
    .get("compose")
    .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  app.get("message").value = "next draft";
  complete(Response.json({}));
  await vi.waitFor(() => expect(app.get("send").disabled).toBe(false));
  expect(app.get("message").value).toBe("next draft");
});

test("room switching immediately removes the previous room member controls", async () => {
  const other = { id: "room-b", name: "Other room", owner_id: alice.userId };
  const app = setup((path) => {
    if (path === "/rooms")
      return Promise.resolve(Response.json({ rooms: [room, other] }));
    if (path === "/rooms/room-a/members")
      return Promise.resolve(
        Response.json({ members: [{ user_id: "github:2", role: "member" }] }),
      );
    if (path === "/rooms/room-b/members") return new Promise(() => {});
  });
  await app.select();
  expect(app.get("members").textContent).toContain("github:2");
  app.get("rooms").querySelectorAll("button")[1].click();
  expect(app.get("members").textContent).not.toContain("github:2");
  expect(app.get("members").querySelector("button")).toBeNull();
});

test("the one-time session token remains visible if refreshing the list fails", async () => {
  let created = false;
  const app = setup((path, options) => {
    if (path === "/sessions" && options.method === "POST") {
      created = true;
      return Promise.resolve(
        Response.json({ id: "new-session", token: "test-only-token" }),
      );
    }
    if (created && path.startsWith("/sessions?"))
      return Promise.reject(new Error("offline"));
  });
  await app.select();
  app.get("create-session").click();
  app.get("dialog-input").value = "test-agent";
  app
    .get("dialog-form")
    .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
  await vi.waitFor(() =>
    expect(app.get("secret-value").value).toBe("test-only-token"),
  );
  expect(app.get("secret-dialog").open).toBe(true);
});

test("a list response from before logout cannot repopulate private data", async () => {
  let complete!: (value: Response) => void;
  const app = setup((path) =>
    path === "/sessions?after="
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : undefined,
  );
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  app.get("logout").click();
  await vi.waitFor(() => expect(app.get("workspace").hidden).toBe(true));
  complete(
    Response.json({
      sessions: [
        {
          name: "Private old session",
          id: "old",
          expires_at: Date.now() + 60000,
        },
      ],
      next_cursor: "",
      has_more: false,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(app.get("sessions").textContent).not.toContain("Private old session");
});

test("a successful send retires its ID even when the user edited the draft", async () => {
  let complete!: (value: Response) => void;
  let attempts = 0;
  const app = setup((path, options) =>
    path.endsWith("/messages") && options.method === "POST"
      ? ++attempts === 1
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(Response.json({}))
      : undefined,
  );
  await app.select();
  app.get("message").value = "A";
  app
    .get("compose")
    .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  app.get("message").value = "B";
  complete(Response.json({}));
  await vi.waitFor(() => expect(app.get("send").disabled).toBe(false));
  app.get("message").value = "A";
  app
    .get("compose")
    .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(attempts).toBe(2));
  const requests = app.fetch.mock.calls
    .filter(([, options]) => options.method === "POST")
    .map(([, options]) => JSON.parse(options.body));
  expect(requests[0].client_message_id).not.toBe(requests[1].client_message_id);
});

test("session download exports only its own CLI credential and closes without retaining it", async () => {
  const app = setup((path, options) =>
    path === "/sessions" && options.method === "POST"
      ? Promise.resolve(
          Response.json({ id: "new-session", token: "test-only-token" }),
        )
      : undefined,
  );
  let blob!: Blob;
  app.w.Blob = Blob as any;
  app.w.URL.createObjectURL = (value: any) => {
    blob = value;
    return "blob:test";
  };
  app.w.URL.revokeObjectURL = vi.fn();
  app.w.HTMLAnchorElement.prototype.click = vi.fn();
  await app.select();
  app.get("create-session").click();
  app.get("dialog-input").value = "test-agent";
  app
    .get("dialog-form")
    .dispatchEvent(new app.w.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(app.get("secret-dialog").open).toBe(true));
  expect(app.get("download-secret")).not.toBeNull();
  app.get("download-secret").click();
  expect(JSON.parse(await blob.text())).toEqual({
    credentials: {
      '["http://localhost:8787/chat/v1","new-session"]': {
        token: "test-only-token",
        kind: "session",
      },
    },
    cursors: {},
  });
  app.get("close-secret").click();
  expect(app.get("download-secret").hidden).toBe(true);
});

test("mobile controls select rooms, conversation and management panels", async () => {
  const app = setup();
  await app.select();
  expect(app.get("workspace").dataset.panel).toBe("conversation");
  app.get("panel-details").click();
  expect(app.get("workspace").dataset.panel).toBe("details");
  expect(app.get("panel-details").getAttribute("aria-pressed")).toBe("true");
  app.get("panel-sidebar").click();
  expect(app.get("workspace").dataset.panel).toBe("sidebar");
});
