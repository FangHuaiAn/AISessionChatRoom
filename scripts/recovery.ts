import { headerValue, messageValue } from "../src/recovery-validation.ts";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { RoomBackup } from "../src/recovery.ts";
import type { Message } from "../src/room.ts";
class RecoveryError extends Error {}
export type Rpc = (method: string, args: unknown[]) => Promise<any>;
type Entry = {
  room_id: string;
  file: string;
  sha256: string;
  message_count: number;
  last_seq: number;
};
type Manifest = {
  version: 1;
  created_at: string;
  registry_last_seq: number;
  rooms: Entry[];
  uninitialized: string[];
};
const filename = (id: string) =>
  createHash("sha256").update(id).digest("hex") + ".jsonl";
async function writeExclusive(path: string, content: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function backup(rpc: Rpc, directory: string) {
  await mkdir(directory, { mode: 0o700 }); // refuse to merge credentials/data with an existing directory
  const registry = await rpc("registryHeader", []);
  const manifest: Manifest = {
    version: 1,
    created_at: new Date().toISOString(),
    registry_last_seq: registry.last_seq,
    rooms: [],
    uninitialized: [],
  };
  let cursor = 0;
  for (;;) {
    const page = await rpc("registeredRooms", [cursor, registry.last_seq]);
    for (const row of page.rooms) {
      let header: RoomBackup;
      try {
        header = await rpc("roomHeader", [row.room_id]);
      } catch (error) {
        if (error instanceof Error && error.message === "not_found") {
          manifest.uninitialized.push(row.room_id);
          continue;
        }
        throw error;
      }
      if (header.room.id !== row.room_id)
        throw new RecoveryError("Invalid room header");
      const name = filename(row.room_id),
        file = await open(join(directory, name), "wx", 0o600),
        hash = createHash("sha256");
      let after = 0,
        count = 0;
      const append = async (value: unknown) => {
        const line = JSON.stringify(value) + "\n";
        hash.update(line);
        await file.writeFile(line);
      };
      try {
        await append({ type: "header", value: header });
        for (;;) {
          const chunk = await rpc("roomPage", [
            row.room_id,
            after,
            header.last_seq,
          ]);
          for (const message of chunk.messages) {
            if (
              message.seq <= after ||
              message.room_id !== row.room_id ||
              message.seq > header.last_seq
            )
              throw new RecoveryError("Invalid message page");
            await append({ type: "message", value: message });
            after = message.seq;
            count++;
          }
          if (!chunk.has_more) break;
          if (chunk.messages.length === 0 || chunk.next_cursor !== after)
            throw new RecoveryError("Invalid backup cursor");
        }
        if (count !== header.message_count || after !== header.last_seq)
          throw new RecoveryError("Incomplete room backup");
        await file.sync();
      } finally {
        await file.close();
      }
      manifest.rooms.push({
        room_id: row.room_id,
        file: name,
        sha256: hash.digest("hex"),
        message_count: count,
        last_seq: after,
      });
    }
    if (!page.has_more) break;
    if (page.next_cursor <= cursor)
      throw new RecoveryError("Invalid registry cursor");
    cursor = page.next_cursor;
  }
  await writeExclusive(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return {
    rooms: manifest.rooms.length,
    uninitialized: manifest.uninitialized.length,
  };
}
async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function* records(path: string) {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) throw new RecoveryError("Empty archive record");
      yield JSON.parse(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
export async function restore(rpc: Rpc, directory: string) {
  const manifest: Manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  if (manifest.version !== 1 || !Array.isArray(manifest.rooms))
    throw new RecoveryError("Unsupported manifest");
  const unique = new Set<string>();
  // Validate every archive before making any write to the target.
  for (const entry of manifest.rooms) {
    if (
      typeof entry.room_id !== "string" ||
      entry.file !== filename(entry.room_id) ||
      unique.has(entry.room_id)
    )
      throw new RecoveryError("Invalid archive path");
    unique.add(entry.room_id);
    const path = join(directory, entry.file);
    if (!(await lstat(path)).isFile() || (await digest(path)) !== entry.sha256)
      throw new RecoveryError("Archive checksum mismatch");
    let header: RoomBackup | undefined,
      count = 0,
      last = 0;
    const ids = new Set<string>(),
      dedupKeys = new Set<string>();
    for await (const record of records(path)) {
      if (!header) {
        if (
          record.type !== "header" ||
          record.value?.version !== 1 ||
          record.value.room?.id !== entry.room_id
        )
          throw new RecoveryError("Invalid archive header");
        header = headerValue(record.value);
        continue;
      }
      const message = messageValue(record.value);
      if (
        record.type !== "message" ||
        message.room_id !== entry.room_id ||
        !Number.isSafeInteger(message.seq) ||
        message.seq <= last ||
        message.seq > header.last_seq
      )
        throw new RecoveryError("Invalid archive message");
      const key = JSON.stringify([
        message.session_id,
        message.client_message_id,
      ]);
      if (
        ids.has(message.id) ||
        dedupKeys.has(key) ||
        (message.reply_to !== null && !ids.has(message.reply_to))
      )
        throw new RecoveryError(
          "Invalid archive reference or duplicate message key",
        );
      ids.add(message.id);
      dedupKeys.add(key);
      last = message.seq;
      count++;
    }
    if (
      !header ||
      count !== entry.message_count ||
      count !== header.message_count ||
      last !== entry.last_seq ||
      last !== header.last_seq
    )
      throw new RecoveryError("Incomplete archive");
  }
  for (const entry of manifest.rooms) {
    const path = join(directory, entry.file);
    let header!: RoomBackup,
      after = 0,
      batch: Message[] = [];
    let complete = false;
    const flush = async () => {
      if (!batch.length) return;
      const result = await rpc("restorePage", [
        entry.room_id,
        header.snapshot_id,
        after,
        batch,
      ]);
      if (result.next_cursor !== batch.at(-1)!.seq)
        throw new RecoveryError("Invalid restore cursor");
      after = result.next_cursor;
      batch = [];
    };
    for await (const record of records(path)) {
      if (record.type === "header") {
        header = record.value;
        const progress = await rpc("restoreBegin", [header]);
        after = progress.next_cursor;
        complete = progress.complete;
        continue;
      }
      if (!complete && record.value.seq > after) {
        batch.push(record.value);
        if (batch.length === 100) await flush();
      }
    }
    if (!complete) await flush();
    if ((await digest(path)) !== entry.sha256)
      throw new RecoveryError("Archive changed during restore");
    await rpc("restoreFinish", [entry.room_id, header.snapshot_id]);
  }
  return { rooms: manifest.rooms.length };
}
async function main() {
  const [command, directory, url = "http://127.0.0.1:8790"] =
    process.argv.slice(2);
  if (!["backup", "restore"].includes(command) || !directory)
    throw new RecoveryError(
      "Usage: node scripts/recovery.ts backup|restore DIRECTORY [http://127.0.0.1:8790]",
    );
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password
  )
    throw new RecoveryError("Maintenance bridge must be loopback HTTP");
  const token = process.env.OPS_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new RecoveryError("OPS_TOKEN must be a 256-bit hex token");
  const rpc: Rpc = async (method, args) => {
    const body = JSON.stringify({ method, args });
    for (let attempt = 0; ; attempt++) {
      let response: Response, result: any;
      try {
        response = await fetch(new URL("/rpc", target), {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        result = await response.json();
      } catch {
        if (attempt < 2) continue;
        throw new RecoveryError("Maintenance bridge connection failed");
      }
      if (response.ok) return result;
      if (response.status >= 500 && attempt < 2) continue;
      throw new RecoveryError(
        [
          "not_found",
          "conflict",
          "bad_request",
          "unauthorized",
          "forbidden",
        ].includes(result.error?.code)
          ? result.error.code
          : "Maintenance request failed",
      );
    }
  };
  console.log(
    JSON.stringify(
      await (command === "backup"
        ? backup(rpc, directory)
        : restore(rpc, directory)),
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    console.error(
      error instanceof RecoveryError
        ? error.message
        : "Recovery failed; inspect the archive and target state before retrying",
    );
    process.exitCode = 1;
  });
