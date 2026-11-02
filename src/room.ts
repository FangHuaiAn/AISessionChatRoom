import { DurableObject } from "cloudflare:workers";
import type { Principal } from "./contracts";
import { hashToken, randomToken } from "./auth/tokens";
import { string } from "./http";
type Message = {
  id: string;
  seq: number;
  room_id: string;
  user_id: string;
  session_id: string;
  body: string;
  reply_to: string | null;
  client_message_id: string;
  created_at: number;
};
export interface MessageInput {
  body: string;
  client_message_id: string;
  reply_to?: string;
}
type RoomInfo = {
  id: string;
  name: string;
  owner_id: string;
  created_at: number;
};
type Invite = {
  id: string;
  hash: string;
  expires_at: number;
  revoked: number;
  used_by: string | null;
};
export class Room extends DurableObject<Env> {
  private waiters = new Map<string, { wake: () => void; cancelled: boolean }>();
  private cancelledWaits = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS room (id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY,joined_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,used_by TEXT);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,room_id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,body TEXT NOT NULL,reply_to TEXT,client_message_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(session_id,client_message_id));`);
  }
  private info(): RoomInfo {
    const row = this.ctx.storage.sql
      .exec<RoomInfo>("SELECT * FROM room")
      .toArray()[0];
    if (!row) throw new Error("not_found");
    return row;
  }
  private member(userId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT user_id FROM members WHERE user_id=?", userId)
        .toArray().length > 0
    );
  }
  private authorize(principal: Principal, owner = false): RoomInfo {
    const info = this.info();
    if (principal.expiresAt <= Date.now()) throw new Error("unauthorized");
    if (
      !this.member(principal.userId) ||
      (principal.kind === "session" && !principal.rooms.includes(info.id))
    )
      throw new Error("not_found");
    if (
      owner &&
      (principal.kind !== "management" || info.owner_id !== principal.userId)
    )
      throw new Error("forbidden");
    return info;
  }
  initialize(id: string, name: string, ownerId: string): RoomInfo {
    const existing = this.ctx.storage.sql
      .exec<RoomInfo>("SELECT * FROM room")
      .toArray()[0];
    if (existing) {
      if (
        existing.id !== id ||
        existing.owner_id !== ownerId ||
        existing.name !== name
      )
        throw new Error("conflict");
      return existing;
    }
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO room VALUES (?,?,?,?)",
        id,
        name,
        ownerId,
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO members VALUES (?,?)",
        ownerId,
        now,
      );
    });
    return this.info();
  }
  listMembers(principal: Principal) {
    const room = this.authorize(principal);
    const members = this.ctx.storage.sql
      .exec<{ user_id: string; joined_at: number }>(
        "SELECT * FROM members ORDER BY joined_at,user_id",
      )
      .toArray()
      .map((member) => ({
        ...member,
        role: member.user_id === room.owner_id ? "owner" : "member",
      }));
    return { members };
  }
  indexMembers(principal: Principal, after: string) {
    const room = this.authorize(principal, true);
    const rows = this.ctx.storage.sql
      .exec<{ user_id: string }>(
        "SELECT user_id FROM members WHERE user_id>? ORDER BY user_id LIMIT 101",
        after,
      )
      .toArray();
    const users = rows.slice(0, 100).map((row) => row.user_id);
    return {
      room_id: room.id,
      users,
      next_cursor: users.at(-1) ?? after,
      has_more: rows.length > 100,
    };
  }
  describe(principal: Principal) {
    return this.authorize(principal);
  }
  async createInvite(principal: Principal) {
    this.authorize(principal, true);
    const secret = randomToken();
    const hash = await hashToken(secret);
    const info = this.authorize(principal, true);
    const id = crypto.randomUUID(),
      expiresAt = Date.now() + 86400000;
    this.ctx.storage.sql.exec(
      "INSERT INTO invites (id,hash,expires_at) VALUES (?,?,?)",
      id,
      hash,
      expiresAt,
    );
    return { id, code: `${info.id}.${secret}`, expires_at: expiresAt };
  }
  async acceptInvite(code: string, userId: string) {
    const [roomId, secret, ...extra] = code.split(".");
    if (extra.length || !secret || roomId !== this.info().id)
      throw new Error("invalid_invite");
    const hash = await hashToken(secret);
    return this.ctx.storage.transactionSync(() => {
      const invite = this.ctx.storage.sql
        .exec<Invite>("SELECT * FROM invites WHERE hash=?", hash)
        .toArray()[0];
      if (
        !invite ||
        invite.revoked ||
        invite.expires_at <= Date.now() ||
        (invite.used_by && (invite.used_by !== userId || !this.member(userId)))
      )
        throw new Error("invalid_invite");
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO members VALUES (?,?)",
        userId,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE invites SET used_by=? WHERE id=?",
        userId,
        invite.id,
      );
      return this.info();
    });
  }
  revokeInvite(principal: Principal, id: string) {
    this.authorize(principal, true);
    this.ctx.storage.sql.exec("UPDATE invites SET revoked=1 WHERE id=?", id);
    return { ok: true };
  }
  removeMember(principal: Principal, userId: string) {
    const info = this.authorize(principal, true);
    if (userId === info.owner_id) throw new Error("conflict");
    this.ctx.storage.sql.exec("DELETE FROM members WHERE user_id=?", userId);
    this.notify();
    return { ok: true };
  }
  private notify() {
    for (const waiter of this.waiters.values()) waiter.wake();
    this.waiters.clear();
  }
  send(principal: Principal, input: MessageInput): Message {
    const info = this.authorize(principal);
    const content = string(input.body, 16000),
      key = string(input.client_message_id, 128);
    const reply =
      input.reply_to === undefined ? null : string(input.reply_to, 128);
    const message = this.ctx.storage.transactionSync(() => {
      const previous = this.ctx.storage.sql
        .exec<Message>(
          "SELECT * FROM messages WHERE session_id=? AND client_message_id=?",
          principal.id,
          key,
        )
        .toArray()[0];
      if (previous) {
        if (previous.body !== content || previous.reply_to !== reply)
          throw new Error("conflict");
        return previous;
      }
      if (
        reply &&
        !this.ctx.storage.sql
          .exec("SELECT id FROM messages WHERE id=?", reply)
          .toArray().length
      )
        throw new Error("bad_request");
      return this.ctx.storage.sql
        .exec<Message>(
          "INSERT INTO messages (id,room_id,user_id,session_id,body,reply_to,client_message_id,created_at) VALUES (?,?,?,?,?,?,?,?) RETURNING *",
          crypto.randomUUID(),
          info.id,
          principal.userId,
          principal.id,
          content,
          reply,
          key,
          Date.now(),
        )
        .one();
    });
    this.notify();
    return message;
  }
  read(principal: Principal, after: number, limit: number) {
    this.authorize(principal);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("bad_request");
    const rows = this.ctx.storage.sql
      .exec<Message>(
        "SELECT * FROM messages WHERE seq>? ORDER BY seq LIMIT ?",
        after,
        limit + 1,
      )
      .toArray();
    const messages = rows.slice(0, limit);
    return {
      messages,
      next_cursor: messages.at(-1)?.seq ?? after,
      has_more: rows.length > limit,
    };
  }
  cancelWait(id: string) {
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter.cancelled = true;
      waiter.wake();
      this.waiters.delete(id);
      return;
    }
    if (!this.cancelledWaits.has(id)) {
      if (this.cancelledWaits.size >= 1000) return;
      this.cancelledWaits.set(
        id,
        setTimeout(() => this.cancelledWaits.delete(id), 31000),
      );
    }
  }
  async waitForMessages(
    principal: Principal,
    after: number,
    limit: number,
    seconds: number,
    waitId: string = crypto.randomUUID(),
  ) {
    if (this.cancelledWaits.has(waitId)) {
      clearTimeout(this.cancelledWaits.get(waitId));
      this.cancelledWaits.delete(waitId);
      throw new Error("request_cancelled");
    }
    const existing = this.read(principal, after, limit);
    if (existing.messages.length || seconds === 0) return existing;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30)
      throw new Error("bad_request");
    if (this.waiters.size >= 100) throw new Error("rate_limited");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter = { wake: () => {}, cancelled: false };
    const ready = new Promise<void>((resolve) => {
      waiter.wake = resolve;
      this.waiters.set(waitId, waiter);
      timer = setTimeout(resolve, seconds * 1000);
    });
    // No await occurs between checking SQL and registering the waiter.
    try {
      await ready;
      if (waiter.cancelled) throw new Error("request_cancelled");
      return this.read(principal, after, limit);
    } finally {
      clearTimeout(timer);
      this.waiters.delete(waitId);
    }
  }
}
