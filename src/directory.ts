import { integer, string } from "./http";
import { DurableObject } from "cloudflare:workers";
import type { CredentialInput, Principal } from "./contracts";
import { hashToken, randomToken } from "./auth/tokens";
import { startDeviceLogin, pollDeviceLogin } from "./auth/github";

type LoginRow = {
  hash: string;
  device_code: string;
  expires_at: number;
  interval: number;
  next_poll: number;
  status: string;
  user_id: string | null;
  name: string | null;
  credential_id: string | null;
  credential_expires: number | null;
};
export type PollResult =
  | {
      status: "complete";
      token: string;
      id: string;
      expires_at: number;
      user_id: string;
      name: string;
    }
  | { status: "authorization_pending" | "slow_down"; interval: number }
  | { status: "access_denied" | "expired_token" };

export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      rooms TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    )`);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_index (user_id TEXT NOT NULL, room_id TEXT NOT NULL, PRIMARY KEY(user_id,room_id))",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_registry (seq INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT UNIQUE NOT NULL)",
    );
    if (
      !this.ctx.storage.sql
        .exec("SELECT seq FROM room_registry LIMIT 1")
        .toArray().length
    )
      this.ctx.storage.sql.exec(
        "INSERT INTO room_registry (room_id) SELECT DISTINCT room_id FROM room_index ORDER BY room_id",
      );
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS logins (
      hash TEXT PRIMARY KEY, device_code TEXT NOT NULL, expires_at INTEGER NOT NULL,
      interval INTEGER NOT NULL, next_poll INTEGER NOT NULL, status TEXT NOT NULL,
      user_id TEXT, name TEXT, credential_id TEXT, credential_expires INTEGER
    )`);
  }
  consumeLimit(key: string, limit: number, seconds: number): boolean {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM rate_limits WHERE expires_at<=?",
        now,
      );
      const row = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT count FROM rate_limits WHERE key=?",
          key,
        )
        .toArray()[0];
      if (row && row.count >= limit) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        key,
        1,
        now + seconds * 1000,
      );
      return true;
    });
  }
  listSessions(userId: string, after = "") {
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        name: string;
        rooms: string;
        expires_at: number;
        revoked: number;
      }>(
        "SELECT id,name,rooms,expires_at,revoked FROM credentials WHERE user_id=? AND kind='session' AND id>? ORDER BY id LIMIT 101",
        userId,
        after,
      )
      .toArray();
    const sessions = rows.slice(0, 100).map((row) => ({
      ...row,
      rooms: JSON.parse(row.rooms),
      revoked: Boolean(row.revoked),
    }));
    return {
      sessions,
      next_cursor: sessions.at(-1)?.id ?? after,
      has_more: rows.length > 100,
    };
  }
  registerRoom(roomId: string) {
    string(roomId);
    this.ctx.storage.sql.exec(
      "INSERT INTO room_registry (room_id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM room_registry WHERE room_id=?)",
      roomId,
      roomId,
    );
  }
  registryHeader() {
    return this.ctx.storage.sql
      .exec<{ last_seq: number }>(
        "SELECT COALESCE(MAX(seq),0) AS last_seq FROM room_registry",
      )
      .one();
  }
  registeredRooms(after: number, through: number) {
    integer(after ?? null, 0, Number.MAX_SAFE_INTEGER, 0);
    integer(through ?? null, 0, Number.MAX_SAFE_INTEGER, 0);
    if (after > through) throw new Error("bad_request");
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; room_id: string }>(
        "SELECT * FROM room_registry WHERE seq>? AND seq<=? ORDER BY seq LIMIT 101",
        after,
        through,
      )
      .toArray();
    const rooms = rows.slice(0, 100);
    return {
      rooms,
      next_cursor: rooms.at(-1)?.seq ?? after,
      has_more: rows.length > 100,
    };
  }
  recordRoom(userId: string, roomId: string) {
    this.registerRoom(roomId);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO room_index VALUES (?,?)",
      userId,
      roomId,
    );
  }
  recordRoomMembers(roomId: string, userIds: string[]) {
    if (userIds.length > 100) throw new Error("bad_request");
    this.ctx.storage.transactionSync(() => {
      for (const userId of userIds) this.recordRoom(userId, roomId);
    });
  }
  roomIds(userId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ room_id: string }>(
        "SELECT room_id FROM room_index WHERE user_id=? ORDER BY room_id",
        userId,
      )
      .toArray()
      .map((row) => row.room_id);
  }
  async startLogin(clientId: string) {
    const instructions = await startDeviceLogin(clientId);
    const secret = randomToken();
    const hash = await hashToken(secret);
    this.ctx.storage.sql.exec(
      "DELETE FROM logins WHERE expires_at <= ?",
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO logins (hash,device_code,expires_at,interval,next_poll,status) VALUES (?,?,?,?,?,?)",
      hash,
      instructions.device_code,
      Date.now() + instructions.expires_in * 1000,
      instructions.interval,
      Date.now() + instructions.interval * 1000,
      "pending",
    );
    return {
      login_secret: secret,
      user_code: instructions.user_code,
      verification_uri: instructions.verification_uri,
      expires_in: instructions.expires_in,
      interval: instructions.interval,
    };
  }
  async pollLogin(clientId: string, secret: string): Promise<PollResult> {
    if (!/^[a-f0-9]{64}$/.test(secret)) return { status: "expired_token" };
    const hash = await hashToken(secret);
    const row = this.ctx.storage.sql
      .exec<LoginRow>("SELECT * FROM logins WHERE hash = ?", hash)
      .toArray()[0];
    if (!row || row.expires_at <= Date.now())
      return { status: "expired_token" };
    if (row.status === "denied") return { status: "access_denied" };
    if (row.status === "expired") return { status: "expired_token" };
    // Domain separation allows retryable delivery without storing the bearer token.
    if (row.status === "complete")
      return {
        status: "complete",
        token: await hashToken("management:" + secret),
        id: row.credential_id!,
        expires_at: row.credential_expires!,
        user_id: row.user_id!,
        name: row.name!,
      };
    if (row.next_poll > Date.now())
      return { status: "authorization_pending", interval: row.interval };
    // Persist a lease before external I/O, preventing concurrent upstream polls.
    this.ctx.storage.sql.exec(
      "UPDATE logins SET next_poll = ? WHERE hash = ?",
      Date.now() + 60000,
      hash,
    );
    try {
      const result = await pollDeviceLogin(clientId, row.device_code);
      if (row.expires_at <= Date.now()) {
        this.ctx.storage.sql.exec(
          "UPDATE logins SET status='expired',device_code='' WHERE hash=?",
          hash,
        );
        return { status: "expired_token" };
      }
      if (result.status === "complete") {
        const token = await hashToken("management:" + secret);
        const tokenHash = await hashToken(token);
        const id = crypto.randomUUID();
        const expiresAt = Date.now() + 86400000;
        const committed = this.ctx.storage.transactionSync(() => {
          const current = this.ctx.storage.sql
            .exec<LoginRow>("SELECT * FROM logins WHERE hash=?", hash)
            .toArray()[0];
          if (
            !current ||
            current.status !== "pending" ||
            current.expires_at <= Date.now()
          )
            return false;
          this.ctx.storage.sql.exec(
            "INSERT INTO credentials (id,token_hash,user_id,kind,name,rooms,expires_at) VALUES (?,?,?,?,?,?,?)",
            id,
            tokenHash,
            result.userId,
            "management",
            result.name,
            "[]",
            expiresAt,
          );
          this.ctx.storage.sql.exec(
            "UPDATE logins SET status='complete',device_code='',user_id=?,name=?,credential_id=?,credential_expires=? WHERE hash=?",
            result.userId,
            result.name,
            id,
            expiresAt,
            hash,
          );
          return true;
        });
        if (!committed) return { status: "expired_token" };
        return {
          status: "complete",
          token,
          id,
          expires_at: expiresAt,
          user_id: result.userId,
          name: result.name,
        };
      }
      if (
        result.status === "access_denied" ||
        result.status === "expired_token"
      ) {
        this.ctx.storage.sql.exec(
          "UPDATE logins SET status=?,device_code='' WHERE hash=?",
          result.status === "access_denied" ? "denied" : "expired",
          hash,
        );
        return { status: result.status };
      }
      const interval = row.interval + (result.status === "slow_down" ? 5 : 0);
      this.ctx.storage.sql.exec(
        "UPDATE logins SET interval=?,next_poll=? WHERE hash=?",
        interval,
        Date.now() + interval * 1000,
        hash,
      );
      return { status: result.status, interval };
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE logins SET next_poll=? WHERE hash=?",
        Date.now() + row.interval * 1000,
        hash,
      );
      throw error;
    }
  }
  async issueCredential(input: CredentialInput) {
    if (
      !Number.isSafeInteger(input.ttl) ||
      input.ttl <= 0 ||
      input.ttl > 2592000
    )
      throw new Error("Invalid credential lifetime");
    const token = randomToken();
    const hash = await hashToken(token);
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + input.ttl * 1000;
    this.ctx.storage.sql.exec(
      "INSERT INTO credentials (id,token_hash,user_id,kind,name,rooms,expires_at) VALUES (?,?,?,?,?,?,?)",
      id,
      hash,
      input.userId,
      input.kind,
      input.name,
      JSON.stringify(input.rooms),
      expiresAt,
    );
    return { id, token, expiresAt };
  }
  async authenticate(token: string): Promise<Principal | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = await hashToken(token);
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        user_id: string;
        kind: Principal["kind"];
        name: string;
        rooms: string;
        expires_at: number;
      }>(
        "SELECT * FROM credentials WHERE token_hash = ? AND revoked = 0 AND expires_at > ?",
        hash,
        Date.now(),
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      name: row.name,
      rooms: JSON.parse(row.rooms),
      expiresAt: row.expires_at,
    };
  }
  revokeCredential(userId: string, id: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          "UPDATE credentials SET revoked = 1 WHERE id = ? AND user_id = ? RETURNING id",
          id,
          userId,
        )
        .toArray().length > 0
    );
  }
}
