import { integer, string } from "./http.ts";
import type { Message, RoomInfo } from "./room.ts";
export type RoomBackup = {
  version: 1;
  snapshot_id: string;
  captured_at: number;
  room: RoomInfo;
  last_seq: number;
  message_count: number;
};
export const nonnegative = (value: unknown) =>
  integer(value ?? null, 0, Number.MAX_SAFE_INTEGER, -1);
export function headerValue(value: RoomBackup): RoomBackup {
  if (!value || value.version !== 1 || !value.room)
    throw new Error("bad_request");
  const result: RoomBackup = {
    version: 1,
    snapshot_id: string(value.snapshot_id),
    captured_at: nonnegative(value.captured_at),
    room: {
      id: string(value.room.id),
      name: string(value.room.name),
      owner_id: string(value.room.owner_id),
      created_at: nonnegative(value.room.created_at),
    },
    last_seq: nonnegative(value.last_seq),
    message_count: nonnegative(value.message_count),
  };
  if (
    result.message_count > result.last_seq ||
    (result.message_count === 0) !== (result.last_seq === 0)
  )
    throw new Error("bad_request");
  return result;
}
export function messageValue(value: Message): Message {
  if (!value) throw new Error("bad_request");
  return {
    seq: integer(value.seq ?? null, 1, Number.MAX_SAFE_INTEGER, 0),
    id: string(value.id),
    room_id: string(value.room_id),
    user_id: string(value.user_id),
    session_id: string(value.session_id),
    body: string(value.body, 16000),
    reply_to: value.reply_to === null ? null : string(value.reply_to),
    client_message_id: string(value.client_message_id),
    created_at: nonnegative(value.created_at),
  };
}
