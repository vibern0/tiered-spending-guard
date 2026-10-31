import { randomBytes } from "node:crypto";
import { assertBackendWebAuthnIdentity } from "./config";
import type { BackendPasskeyRole } from "./webauthn";

export type RegistrationSession = Readonly<{
  id: string;
  role: BackendPasskeyRole;
  challenge: string;
  rpId: string;
  origin: string;
  used: boolean;
}>;

function sessionId(): string {
  return randomBytes(24).toString("base64url");
}

function challenge(): string {
  return randomBytes(32).toString("base64url");
}

export class RegistrationSessionStore {
  private readonly sessions = new Map<string, RegistrationSession>();
  private readonly roles = new Set<BackendPasskeyRole>();

  constructor(private readonly profile: Readonly<{ id: "local" | "https"; origin: string; rpId: string }>) {
    assertBackendWebAuthnIdentity(profile.id, profile.origin, profile.rpId);
  }

  create(role: BackendPasskeyRole): RegistrationSession {
    if (role !== "primary" && role !== "secondary") throw new Error("unsupported passkey role");
    if (this.roles.has(role)) throw new Error(`${role} passkey is already registered`);
    const session = Object.freeze({ id: sessionId(), role, challenge: challenge(), rpId: this.profile.rpId, origin: this.profile.origin, used: false });
    this.sessions.set(session.id, session);
    this.roles.add(role);
    return session;
  }

  consume(id: string, role: BackendPasskeyRole): RegistrationSession {
    const session = this.sessions.get(id);
    if (!session || session.used || session.role !== role) throw new Error("unknown or already used registration session");
    const consumed = Object.freeze({ ...session, used: true });
    this.sessions.set(id, consumed);
    return consumed;
  }

  clear(role: BackendPasskeyRole): void {
    this.roles.delete(role);
    for (const [id, session] of this.sessions) if (session.role === role) this.sessions.delete(id);
  }
}
