import { mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
interface State {
  credentials: Record<
    string,
    { token: string; kind: "management" | "session" }
  >;
  cursors: Record<string, number>;
}
export class ConfigStore {
  readonly file: string;
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, "config.json");
  }
  private async read(): Promise<State> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { credentials: {}, cursors: {} };
      throw new Error("Cannot read CLI configuration");
    }
  }
  private async update(change: (state: State) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const lockPath = join(this.dir, "config.lock");
    let lock;
    const deadline = Date.now() + 10000;
    while (!lock) {
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() > deadline)
          throw new Error(
            "CLI configuration is locked; inspect config.lock before removing a stale lock",
          );
        await sleep(25);
      }
    }
    const temp = join(this.dir, `config-${crypto.randomUUID()}.tmp`);
    try {
      const state = await this.read();
      change(state);
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(state, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.file);
    } finally {
      await unlink(temp).catch(() => {});
      await lock.close();
      await unlink(lockPath);
    }
  }
  private key(base: string, id: string) {
    return JSON.stringify([base, id]);
  }
  async saveCredential(
    base: string,
    id: string,
    token: string,
    kind: "management" | "session",
  ) {
    await this.update((state) => {
      state.credentials[this.key(base, id)] = { token, kind };
      if (kind === "management")
        state.credentials[this.key(base, "management")] = { token, kind };
    });
  }
  async token(base: string, id = "management"): Promise<string> {
    const credential = (await this.read()).credentials[this.key(base, id)];
    if (!credential)
      throw new Error(
        "Credential missing; login or select a configured session",
      );
    return credential.token;
  }
  async forget(base: string, id: string) {
    await this.update((state) => {
      delete state.credentials[this.key(base, id)];
    });
  }
  async cursor(base: string, session: string, room: string): Promise<number> {
    return (
      (await this.read()).cursors[JSON.stringify([base, session, room])] ?? 0
    );
  }
  async ack(base: string, session: string, room: string, cursor: number) {
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error("Invalid cursor");
    await this.update((state) => {
      const key = JSON.stringify([base, session, room]);
      if (cursor < (state.cursors[key] ?? 0))
        throw new Error("Cannot move cursor backwards");
      state.cursors[key] = cursor;
    });
  }
}
