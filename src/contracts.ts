export interface Principal {
  id: string;
  userId: string;
  kind: "management" | "session";
  name: string;
  rooms: string[];
  expiresAt: number;
}
export interface CredentialInput {
  userId: string;
  kind: Principal["kind"];
  name: string;
  rooms: string[];
  ttl: number;
}
