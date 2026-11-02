import { string } from "./http";
import {
  headerValue,
  messageValue,
  nonnegative,
  type RoomBackup,
} from "./recovery-validation";
import type { Message, RoomInfo } from "./room";
export type { RoomBackup } from "./recovery-validation";
type RecoveryState = {
  snapshot_id: string;
  header: string;
  cursor: number;
  complete: number;
};
const fields = [
  "seq",
  "id",
  "room_id",
  "user_id",
  "session_id",
  "body",
  "reply_to",
  "client_message_id",
  "created_at",
] as const;
// Only called through DO RPC; the public HTTP router never dispatches these operations.
export class RoomRecovery {
  constructor(private state: DurableObjectState) {
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS recovery_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),snapshot_id TEXT NOT NULL,header TEXT NOT NULL,cursor INTEGER NOT NULL,complete INTEGER NOT NULL)",
    );
  }
  private current() {
    return this.state.storage.sql
      .exec<RecoveryState>("SELECT * FROM recovery_state WHERE singleton=1")
      .toArray()[0];
  }
  backupHeader(): RoomBackup {
    if (this.current()?.complete === 0) throw new Error("conflict");
    const room = this.state.storage.sql
      .exec<RoomInfo>("SELECT * FROM room")
      .toArray()[0];
    if (!room) throw new Error("not_found");
    const totals = this.state.storage.sql
      .exec<{ last_seq: number; message_count: number }>(
        "SELECT COALESCE(MAX(seq),0) AS last_seq,COUNT(*) AS message_count FROM messages",
      )
      .one();
    return {
      version: 1,
      snapshot_id: crypto.randomUUID(),
      captured_at: Date.now(),
      room,
      ...totals,
    };
  }
  backupPage(after: number, through: number) {
    nonnegative(after);
    nonnegative(through);
    if (after > through) throw new Error("bad_request");
    if (this.current()?.complete === 0) throw new Error("conflict");
    const rows = this.state.storage.sql
      .exec<Message>(
        "SELECT * FROM messages WHERE seq>? AND seq<=? ORDER BY seq LIMIT 101",
        after,
        through,
      )
      .toArray();
    const messages = rows.slice(0, 100);
    return {
      messages,
      next_cursor: messages.at(-1)?.seq ?? after,
      has_more: rows.length > 100,
    };
  }
  begin(input: RoomBackup) {
    const header = headerValue(input),
      encoded = JSON.stringify(header);
    return this.state.storage.transactionSync(() => {
      const existing = this.current();
      if (existing) {
        if (existing.header !== encoded) throw new Error("conflict");
        return {
          next_cursor: existing.cursor,
          complete: Boolean(existing.complete),
        };
      }
      if (
        this.state.storage.sql.exec("SELECT id FROM room LIMIT 1").toArray()
          .length
      )
        throw new Error("conflict");
      const room = header.room;
      this.state.storage.sql.exec(
        "INSERT INTO room VALUES (?,?,?,?)",
        room.id,
        room.name,
        room.owner_id,
        room.created_at,
      );
      this.state.storage.sql.exec(
        "INSERT INTO recovery_state VALUES (1,?,?,0,0)",
        header.snapshot_id,
        encoded,
      );
      return { next_cursor: 0, complete: false };
    });
  }
  page(snapshotId: string, after: number, input: Message[]) {
    string(snapshotId);
    nonnegative(after);
    if (!Array.isArray(input) || input.length === 0 || input.length > 100)
      throw new Error("bad_request");
    const messages = input.map(messageValue);
    return this.state.storage.transactionSync(() => {
      const state = this.current();
      if (
        !state ||
        state.complete ||
        state.snapshot_id !== snapshotId ||
        after > state.cursor
      )
        throw new Error("conflict");
      const header: RoomBackup = JSON.parse(state.header);
      let previous = after;
      for (const message of messages) {
        if (
          message.room_id !== header.room.id ||
          message.seq <= previous ||
          message.seq > header.last_seq
        )
          throw new Error("bad_request");
        previous = message.seq;
        const existing = this.state.storage.sql
          .exec<Message>(
            "SELECT * FROM messages WHERE seq=? OR id=? OR (session_id=? AND client_message_id=?)",
            message.seq,
            message.id,
            message.session_id,
            message.client_message_id,
          )
          .toArray();
        if (existing.length) {
          if (
            existing.length !== 1 ||
            !fields.every((key) => existing[0][key] === message[key])
          )
            throw new Error("conflict");
          continue;
        }
        if (after !== state.cursor) throw new Error("conflict");
        if (
          message.reply_to &&
          !this.state.storage.sql
            .exec(
              "SELECT id FROM messages WHERE id=? AND seq<?",
              message.reply_to,
              message.seq,
            )
            .toArray().length
        )
          throw new Error("bad_request");
        this.state.storage.sql.exec(
          "INSERT INTO messages (seq,id,room_id,user_id,session_id,body,reply_to,client_message_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          ...fields.map((key) => message[key]),
        );
      }
      const count = this.state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages")
        .one().count;
      if (count > header.message_count) throw new Error("conflict");
      const cursor = Math.max(state.cursor, previous);
      this.state.storage.sql.exec(
        "UPDATE recovery_state SET cursor=? WHERE singleton=1",
        cursor,
      );
      return { next_cursor: cursor };
    });
  }
  finish(snapshotId: string) {
    return this.state.storage.transactionSync(() => {
      const state = this.current();
      if (!state || state.snapshot_id !== snapshotId)
        throw new Error("conflict");
      const header: RoomBackup = JSON.parse(state.header);
      if (state.complete) return header.room;
      const count = this.state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages")
        .one().count;
      if (state.cursor !== header.last_seq || count !== header.message_count)
        throw new Error("conflict");
      this.state.storage.sql.exec(
        "INSERT INTO members VALUES (?,?)",
        header.room.owner_id,
        Date.now(),
      );
      this.state.storage.sql.exec(
        "UPDATE recovery_state SET complete=1 WHERE singleton=1",
      );
      return header.room;
    });
  }
}
