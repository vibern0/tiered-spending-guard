import { randomBytes } from "node:crypto";
import { assertBackendWebAuthnIdentity } from "./config";
import type { BackendPasskeyRole } from "./webauthn";

export type RegistrationSession = Readonly<{
  id: string;
  role: BackendPasskeyRole;
  challenge: string;
  rpId: string;
  origin: string;
  authenticatorAttachment: "platform" | "cross-platform";
  used: boolean;
}>;

export type RebindSession = Readonly<{
  id: string;
  role: BackendPasskeyRole;
  challenge: string;
  rpId: string;
  origin: string;
  expiresAt: number;
}>;

function sessionId(): string {
  return randomBytes(24).toString("base64url");
}

function challenge(): string {
  return randomBytes(32).toString("base64url");
}

export class RegistrationSessionStore {
  private readonly sessions = new Map<string, RegistrationSession>();
  private readonly registeredRoles = new Set<BackendPasskeyRole>();

  constructor(
    private readonly profile: Readonly<{ id: "local" | "https"; origin: string; rpId: string }>,
  ) {
    assertBackendWebAuthnIdentity(profile.id, profile.origin, profile.rpId);
  }

  create(role: BackendPasskeyRole): RegistrationSession {
    if (role !== "primary" && role !== "secondary") throw new Error("unsupported passkey role");
    if (this.registeredRoles.has(role)) throw new Error(`${role} passkey is already registered`);
    const session = Object.freeze({
      id: sessionId(),
      role,
      challenge: challenge(),
      rpId: this.profile.rpId,
      origin: this.profile.origin,
      authenticatorAttachment:
        role === "primary" ? ("platform" as const) : ("cross-platform" as const),
      used: false,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  markRegistered(role: BackendPasskeyRole): void {
    this.registeredRoles.add(role);
    for (const [id, session] of this.sessions) if (session.role === role) this.sessions.delete(id);
  }

  consume(id: string, role: BackendPasskeyRole): RegistrationSession {
    const session = this.sessions.get(id);
    if (!session || session.used || session.role !== role)
      throw new Error("unknown or already used registration session");
    const consumed = Object.freeze({ ...session, used: true });
    this.sessions.set(id, consumed);
    return consumed;
  }

  clear(role: BackendPasskeyRole): void {
    this.registeredRoles.delete(role);
    for (const [id, session] of this.sessions) if (session.role === role) this.sessions.delete(id);
  }
}

export class RebindSessionStore {
  private readonly sessions = new Map<string, RebindSession>();

  constructor(
    private readonly profile: Readonly<{ id: "local" | "https"; origin: string; rpId: string }>,
    private readonly now: () => number = Date.now,
  ) {
    assertBackendWebAuthnIdentity(profile.id, profile.origin, profile.rpId);
  }

  create(role: BackendPasskeyRole): RebindSession {
    if (this.profile.id !== "local")
      throw new Error("credential rebind is available only in the local recovery profile");
    if (role !== "primary" && role !== "secondary") throw new Error("unsupported passkey role");
    const session = Object.freeze({
      id: sessionId(),
      role,
      challenge: challenge(),
      rpId: this.profile.rpId,
      origin: this.profile.origin,
      expiresAt: this.now() + 5 * 60_000,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  consume(id: string, role: BackendPasskeyRole): RebindSession {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (!session || session.role !== role)
      throw new Error("unknown or already used credential rebind session");
    if (session.expiresAt < this.now()) throw new Error("credential rebind session expired");
    return session;
  }
}
