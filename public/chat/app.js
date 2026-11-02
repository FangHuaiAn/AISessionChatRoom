// The browser uses only an HttpOnly cookie; management tokens never enter this module.
const $ = (id) => document.getElementById(id);
const state = {
  generation: 0,
  user: null,
  rooms: [],
  room: null,
  cursor: 0,
  seen: new Set(),
  reply: null,
  controller: null,
  loginController: null,
  sessionsAfter: "",
  draft: null,
};
const errors = {
  unauthorized: "登入已到期，請重新登入。",
  forbidden: "你沒有執行此操作的權限。",
  not_found: "找不到房間，或你已不再是成員。",
  invalid_invite: "邀請碼無效、已使用或已到期。",
  conflict: "內容與原本的請求衝突，請重新確認。",
  rate_limited: "請求較頻繁，請稍後再試。",
  not_configured: "服務尚未設定 GitHub 登入，請聯絡管理者。",
  bad_request: "請檢查輸入內容。",
};
function status(message = "", error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function report(error) {
  if (error.name === "AbortError") return;
  status(errors[error.message] ?? "連線暫時失敗，請稍後重試。", true);
}
async function api(path, { method = "GET", body, signal } = {}) {
  const generation = state.generation;
  const response = await fetch("/chat/v1" + path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (generation !== state.generation)
    throw new DOMException("Stale response", "AbortError");
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(result.error?.code ?? "request_failed");
  }
  return result;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, className = "quiet") {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", () => Promise.resolve(action()).catch(report));
  return node;
}
const short = (value) =>
  value.length > 18 ? value.slice(0, 8) + "…" + value.slice(-5) : value;
function selectPanel(panel) {
  $("workspace").dataset.panel = panel;
  for (const name of ["sidebar", "conversation", "details"])
    $("panel-" + name).setAttribute("aria-pressed", String(name === panel));
}
for (const panel of ["sidebar", "conversation", "details"])
  $("panel-" + panel).addEventListener("click", () => selectPanel(panel));
function showLogin() {
  selectPanel("sidebar");
  state.controller?.abort();
  state.generation++;
  state.loginController?.abort();
  state.user = null;
  state.room = null;
  state.rooms = [];
  state.cursor = 0;
  state.seen.clear();
  state.reply = null;
  state.draft = null;
  state.sessionsAfter = "";
  for (const id of ["messages", "rooms", "members", "sessions"])
    $(id).replaceChildren();
  $("message").value = "";
  $("dialog-input").value = "";
  $("secret-value").value = "";
  $("secret-id").textContent = "";
  $("device-code").textContent = "";
  $("form-dialog").close();
  $("secret-dialog").close();
  $("compose").hidden = true;
  $("reply-context").hidden = true;
  $("device-login").hidden = true;
  $("empty-room").hidden = false;
  $("invite").hidden = true;
  $("create-session").disabled = true;
  $("room-title").textContent = "選擇聊天室";
  $("room-meta").textContent = "開始一場屬於你們的討論。";
  $("connection").textContent = "尚未連線";
  $("connection").classList.remove("live");
  $("workspace").hidden = true;
  $("login-view").hidden = false;
  $("logout").hidden = true;
  $("identity").textContent = "私人協作空間";
}
async function enter() {
  state.user = await api("/auth/me");
  $("identity").textContent = state.user.name;
  $("logout").hidden = false;
  $("login-view").hidden = true;
  $("workspace").hidden = false;
  await Promise.all([loadRooms(), loadSessions(true)]);
}
async function loadRooms() {
  const { rooms } = await api("/rooms");
  state.rooms = rooms;
  $("rooms").replaceChildren();
  for (const room of rooms) {
    const node = button(
      room.name,
      () => selectRoom(room),
      "room-button" + (state.room?.id === room.id ? " active" : ""),
    );
    node.setAttribute(
      "aria-current",
      state.room?.id === room.id ? "true" : "false",
    );
    $("rooms").append(node);
  }
  if (!rooms.length) $("rooms").append(el("p", "muted", "尚未加入聊天室。"));
}
async function selectRoom(room) {
  selectPanel("conversation");
  state.controller?.abort();
  state.room = room;
  state.cursor = 0;
  state.seen = new Set();
  state.reply = null;
  state.draft = null;
  $("message").value = "";
  $("reply-context").hidden = true;
  $("messages").replaceChildren();
  $("members").replaceChildren(el("p", "muted", "載入成員中…"));
  $("empty-room").hidden = true;
  $("compose").hidden = false;
  $("room-title").textContent = room.name;
  $("room-meta").textContent = "私人聊天室 · " + short(room.id);
  $("create-session").disabled = false;
  $("invite").hidden = room.owner_id !== state.user.userId;
  await loadRooms();
  await loadMembers(room);
  if (state.room?.id === room.id) startPolling();
}
function renderMessages(messages) {
  for (const message of messages) {
    if (state.seen.has(message.id)) continue;
    state.seen.add(message.id);
    const article = el("article", "message");
    article.id = "message-" + message.id;
    const header = el("div", "message-header");
    header.append(
      el(
        "span",
        "message-author",
        message.user_id === state.user.userId ? "你" : message.user_id,
      ),
      el("span", "message-session", short(message.session_id)),
    );
    const time = el(
      "time",
      "",
      new Date(message.created_at).toLocaleString("zh-TW", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    time.dateTime = new Date(message.created_at).toISOString();
    header.append(time);
    article.append(header);
    if (message.reply_to)
      article.append(
        el("div", "message-reply", "回覆 " + short(message.reply_to)),
      );
    article.append(el("p", "message-body", message.body));
    const actions = el("div", "message-actions");
    actions.append(
      button("回覆", () => {
        state.reply = message.id;
        $("reply-label").textContent = "回覆 " + short(message.id);
        $("reply-context").hidden = false;
        $("message").focus();
      }),
    );
    article.append(actions);
    $("messages").append(article);
  }
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function startPolling() {
  state.controller?.abort();
  if (!state.room || document.hidden) return;
  const controller = new AbortController();
  state.controller = controller;
  const room = state.room;
  void (async () => {
    let wait = 0;
    while (!controller.signal.aborted && state.room?.id === room.id) {
      try {
        $("connection").textContent = "同步中";
        $("connection").classList.add("live");
        const result = await api(
          `/rooms/${encodeURIComponent(room.id)}/messages?after=${state.cursor}&limit=100&wait=${wait}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || state.room?.id !== room.id) return;
        const log = $("messages"),
          nearBottom =
            log.scrollHeight - log.scrollTop - log.clientHeight < 140;
        renderMessages(result.messages);
        state.cursor = result.next_cursor;
        if (nearBottom) log.scrollTop = log.scrollHeight;
        $("connection").textContent = "已連線";
        wait = result.has_more ? 0 : 25;
      } catch (error) {
        if (controller.signal.aborted || error.name === "AbortError") return;
        $("connection").classList.remove("live");
        $("connection").textContent = "重新連線中";
        report(error);
        if (
          ["unauthorized", "not_found", "forbidden"].includes(error.message)
        ) {
          controller.abort();
          return;
        }
        await pause(3000, controller.signal).catch(() => {});
      }
    }
  })().catch(report);
}
async function loadMembers(room = state.room) {
  if (!room) return;
  const result = await api(`/rooms/${encodeURIComponent(room.id)}/members`);
  if (state.room?.id !== room.id) return;
  $("members").replaceChildren();
  for (const member of result.members) {
    const node = el("div", "member"),
      label = el(
        "div",
        "member-name",
        member.user_id === state.user.userId ? state.user.name : member.user_id,
      );
    if (member.role === "owner") label.append(el("span", "badge", "房主"));
    node.append(label);
    if (room.owner_id === state.user.userId && member.role !== "owner")
      node.append(
        button(
          "移除",
          async () => {
            if (!confirm("移除此成員？對方將無法再讀取或發送訊息。")) return;
            await api(
              `/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(member.user_id)}`,
              { method: "DELETE" },
            );
            await loadMembers(room);
          },
          "quiet danger",
        ),
      );
    $("members").append(node);
  }
}
async function loadSessions(reset = false) {
  const result = await api(
    "/sessions?after=" + encodeURIComponent(reset ? "" : state.sessionsAfter),
  );
  if (reset) $("sessions").replaceChildren();
  for (const session of result.sessions) {
    const card = el("div", "session-card");
    card.append(
      el("strong", "", session.name),
      el("p", "", short(session.id)),
      el(
        "p",
        "",
        session.revoked
          ? "已撤銷"
          : session.expires_at <= Date.now()
            ? "已到期"
            : "到期 " + new Date(session.expires_at).toLocaleString("zh-TW"),
      ),
    );
    if (!session.revoked && session.expires_at > Date.now())
      card.append(
        button(
          "撤銷憑證",
          async () => {
            if (!confirm("撤銷這個 session 的存取憑證？")) return;
            await api("/sessions/" + encodeURIComponent(session.id), {
              method: "DELETE",
            });
            await loadSessions(true);
          },
          "quiet danger",
        ),
      );
    $("sessions").append(card);
  }
  state.sessionsAfter = result.next_cursor;
  $("more-sessions").hidden = !result.has_more;
  if (reset && !result.sessions.length)
    $("sessions").append(el("p", "muted", "尚未建立 session。"));
}
let dialogAction = null;
function formDialog(title, description, label, action) {
  $("dialog-title").textContent = title;
  $("dialog-description").textContent = description;
  $("dialog-label").textContent = label;
  $("dialog-input").value = "";
  dialogAction = action;
  $("form-dialog").showModal();
  $("dialog-input").focus();
}
let secretDownload = null;
function secret(title, description, value, id = "", download = null) {
  secretDownload = download;
  $("download-secret").hidden = download === null;
  $("secret-title").textContent = title;
  $("secret-description").textContent = description;
  $("secret-value").value = value;
  $("secret-id").textContent = id;
  $("copy-secret").textContent = "複製";
  $("secret-dialog").showModal();
}
$("dialog-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = $("dialog-input").value.trim();
  if (!value) return;
  $("dialog-submit").disabled = true;
  try {
    await dialogAction(value);
    $("form-dialog").close();
    status("操作完成。");
  } catch (error) {
    report(error);
  } finally {
    $("dialog-submit").disabled = false;
  }
});
for (const id of ["close-dialog", "dialog-cancel"])
  $(id).addEventListener("click", () => $("form-dialog").close());
$("close-secret").addEventListener("click", () => $("secret-dialog").close());
$("secret-dialog").addEventListener("close", () => {
  secretDownload = null;
  $("download-secret").hidden = true;
  $("secret-value").value = "";
  $("secret-id").textContent = "";
});
$("download-secret").addEventListener("click", () => {
  if (!secretDownload) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(secretDownload, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "config.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});
$("copy-secret").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("secret-value").value);
    $("copy-secret").textContent = "已複製";
  } catch {
    status("無法使用剪貼簿，請手動選取複製。", true);
    $("secret-value").select();
  }
});
$("create-room").addEventListener("click", () =>
  formDialog(
    "建立私人聊天室",
    "建立後可邀請夥伴加入。",
    "聊天室名稱",
    async (name) => {
      const room = await api("/rooms", {
        method: "POST",
        body: { name, request_id: crypto.randomUUID() },
      });
      await selectRoom(room);
    },
  ),
);
$("accept-invite").addEventListener("click", () =>
  formDialog(
    "加入聊天室",
    "加入後可讀取房間的完整歷史。",
    "邀請碼",
    async (code) => {
      const room = await api("/invites/accept", {
        method: "POST",
        body: { code },
      });
      await selectRoom(room);
    },
  ),
);
$("invite").addEventListener("click", async () => {
  try {
    const result = await api(
      `/rooms/${encodeURIComponent(state.room.id)}/invites`,
      { method: "POST", body: {} },
    );
    secret(
      "邀請夥伴",
      "此邀請碼只能使用一次，有效 24 小時。請自行交給受邀者。",
      result.code,
      "邀請 ID：" + result.id,
    );
  } catch (error) {
    report(error);
  }
});
$("create-session").addEventListener("click", () => {
  const room = state.room;
  if (!room) return;
  formDialog(
    "建立 AI Session",
    "此憑證只能存取「" + room.name + "」，有效 24 小時。",
    "Session 名稱",
    async (name) => {
      const result = await api("/sessions", {
        method: "POST",
        body: { name, rooms: [room.id] },
      });
      secret(
        "Session 憑證",
        "請立即複製保存，關閉後無法再次顯示。只提供給指定的 AI 執行環境。",
        result.token,
        "Session ID：" + result.id,
        {
          credentials: {
            [JSON.stringify([location.origin + "/chat/v1", result.id])]: {
              token: result.token,
              kind: "session",
            },
          },
          cursors: {},
        },
      );
      void loadSessions(true).catch(report);
    },
  );
});
$("more-sessions").addEventListener("click", () =>
  loadSessions().catch(report),
);
$("cancel-reply").addEventListener("click", () => {
  state.reply = null;
  $("reply-context").hidden = true;
});
$("compose").addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = $("message").value;
  if (!content.trim() || !state.room || $("send").disabled) return;
  const room = state.room;
  const payload = {
    body: content,
    ...(state.reply ? { reply_to: state.reply } : {}),
  };
  if (
    !state.draft ||
    state.draft.room !== room.id ||
    state.draft.content !== JSON.stringify(payload)
  )
    state.draft = {
      room: room.id,
      content: JSON.stringify(payload),
      id: crypto.randomUUID(),
    };
  const submittedDraft = state.draft;
  $("send").disabled = true;
  try {
    await api(`/rooms/${encodeURIComponent(room.id)}/messages`, {
      method: "POST",
      body: { ...payload, client_message_id: submittedDraft.id },
    });
    if (state.draft === submittedDraft) state.draft = null;
    if (
      state.room?.id === room.id &&
      $("message").value === content &&
      (state.reply ?? undefined) === payload.reply_to
    ) {
      $("message").value = "";
      state.reply = null;
      state.draft = null;
      $("reply-context").hidden = true;
    }
    status();
  } catch (error) {
    report(error);
  } finally {
    $("send").disabled = false;
  }
});
$("message").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("compose").requestSubmit();
  }
});
$("login").addEventListener("click", async () => {
  state.loginController?.abort();
  const controller = new AbortController();
  state.loginController = controller;
  $("login").disabled = true;
  status();
  try {
    const started = await api("/auth/browser/start", {
      method: "POST",
      body: {},
      signal: controller.signal,
    });
    $("device-code").textContent = started.user_code;
    $("github-link").href = "https://github.com/login/device";
    $("device-login").hidden = false;
    const deadline = Date.now() + started.expires_in * 1000;
    let interval = started.interval;
    while (Date.now() < deadline && !controller.signal.aborted) {
      await pause(interval * 1000, controller.signal);
      const result = await api("/auth/browser/poll", {
        method: "POST",
        body: { login_secret: started.login_secret },
        signal: controller.signal,
      });
      if (result.status === "complete") {
        $("device-login").hidden = true;
        await enter();
        return;
      }
      if (["authorization_pending", "slow_down"].includes(result.status)) {
        interval = result.interval ?? interval;
        continue;
      }
      throw new Error(result.status);
    }
    if (!controller.signal.aborted) status("驗證碼已到期，請重新登入。", true);
  } catch (error) {
    report(error);
  } finally {
    $("login").disabled = false;
  }
});
$("cancel-login").addEventListener("click", () => {
  state.loginController?.abort();
  $("device-login").hidden = true;
  $("login").disabled = false;
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST", body: {} });
    showLogin();
    status("已登出。");
  } catch (error) {
    report(error);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.controller?.abort();
    $("connection").textContent = "暫停同步";
  } else if (state.user && state.room) startPolling();
});
window.addEventListener("pagehide", () => {
  state.controller?.abort();
  state.loginController?.abort();
});
void enter().catch((error) => {
  if (error.name === "AbortError") return;
  showLogin();
  if (error.message !== "unauthorized") report(error);
});
