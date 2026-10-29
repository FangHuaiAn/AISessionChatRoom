import { DurableObject } from 'cloudflare:workers';
import type { CredentialInput, Principal } from './contracts';
import { hashToken, randomToken } from './auth/tokens';

export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      rooms TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    )`);
  }
  async issueCredential(input: CredentialInput) {
    if (!Number.isSafeInteger(input.ttl) || input.ttl <= 0 || input.ttl > 2592000) throw new Error('Invalid credential lifetime');
    const token = randomToken();
    const hash = await hashToken(token);
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + input.ttl * 1000;
    this.ctx.storage.sql.exec(
      'INSERT INTO credentials (id,token_hash,user_id,kind,name,rooms,expires_at) VALUES (?,?,?,?,?,?,?)',
      id, hash, input.userId, input.kind, input.name, JSON.stringify(input.rooms), expiresAt,
    );
    return {id, token, expiresAt};
  }
  async authenticate(token: string): Promise<Principal | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = await hashToken(token);
    const row = this.ctx.storage.sql.exec<{
      id:string; user_id:string; kind:Principal['kind']; name:string; rooms:string; expires_at:number;
    }>('SELECT * FROM credentials WHERE token_hash = ? AND revoked = 0 AND expires_at > ?', hash, Date.now()).toArray()[0];
    if (!row) return null;
    return {id:row.id, userId:row.user_id, kind:row.kind, name:row.name, rooms:JSON.parse(row.rooms), expiresAt:row.expires_at};
  }
  revokeCredential(userId: string, id: string): boolean {
    return this.ctx.storage.sql.exec('UPDATE credentials SET revoked = 1 WHERE id = ? AND user_id = ? RETURNING id', id, userId).toArray().length > 0;
  }
}
