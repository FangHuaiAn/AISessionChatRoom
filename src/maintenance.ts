import { headerValue } from "./recovery-validation";
import { WorkerEntrypoint } from "cloudflare:workers";
import { string } from "./http";
import type { RoomBackup } from "./recovery";
import type { Message } from "./room";

// No public HTTP endpoint. Accessible only to an account-authorized service binding
// explicitly selecting the Maintenance entrypoint.
export class Maintenance extends WorkerEntrypoint<Env> {
  registryHeader() {
    return this.env.DIRECTORY.getByName("directory").registryHeader();
  }
  registeredRooms(after: number, through: number) {
    return this.env.DIRECTORY.getByName("directory").registeredRooms(
      after,
      through,
    );
  }
  roomHeader(roomId: string) {
    return this.env.ROOMS.getByName(string(roomId)).backupHeader();
  }
  roomPage(roomId: string, after: number, through: number) {
    return this.env.ROOMS.getByName(string(roomId)).backupPage(after, through);
  }
  async restoreBegin(header: RoomBackup) {
    header = headerValue(header);
    const id = header.room.id;
    await this.env.DIRECTORY.getByName("directory").registerRoom(id);
    return this.env.ROOMS.getByName(id).restoreBegin(header);
  }
  restorePage(
    roomId: string,
    snapshotId: string,
    after: number,
    messages: Message[],
  ) {
    return this.env.ROOMS.getByName(string(roomId)).restorePage(
      snapshotId,
      after,
      messages,
    );
  }
  async restoreFinish(roomId: string, snapshotId: string) {
    const room = await this.env.ROOMS.getByName(string(roomId)).restoreFinish(
      snapshotId,
    );
    await this.env.DIRECTORY.getByName("directory").recordRoom(
      room.owner_id,
      room.id,
    );
    return room;
  }
}
