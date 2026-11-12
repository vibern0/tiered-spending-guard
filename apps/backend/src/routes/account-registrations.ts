import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { BackendConfig } from "../config";
import type { AccountStore } from "../account-store";
import { verifyPasskeyRegistration } from "../webauthn";
import { AccountHttpError, exact, passkeyRole, type AccountRouteContext } from "./account-context";

type RoleParams = Readonly<{ role: string }>;

export function registerAccountRegistrationRoutes(
  fastify: FastifyInstance,
  config: BackendConfig,
  store: AccountStore,
  context: AccountRouteContext,
): void {
  fastify.post<{ Params: RoleParams }>(
    "/v1/registrations/:role/options",
    async (request, reply) => {
      const account = context.account(request);
      const role = passkeyRole(request.params.role);
      if (
        account.state !== "registering" ||
        store.credentials(account.id).some((credential) => credential.role === role)
      )
        throw new AccountHttpError(409, "existing signer cannot be replaced through registration");
      if (role === "secondary") context.session(request, true);
      exact(request.body as Record<string, unknown>, []);
      const session = context.session(request);
      const challenge = store.createChallenge(session.id, "registration", role);
      return reply.send({
        sessionId: challenge.id,
        challenge: challenge.challenge,
        rpId: config.rpId,
        origin: config.origin,
        role,
        userVerification: "required",
        userHandle:
          role === "primary"
            ? account.userHandle
            : createHash("sha256")
                .update(`vault-secondary:${account.userHandle}`)
                .digest("base64url"),
        ...(role === "secondary" ? { authenticatorAttachment: "cross-platform" } : {}),
      });
    },
  );

  fastify.post<{ Params: RoleParams }>("/v1/registrations/:role/verify", async (request, reply) => {
    const account = context.account(request);
    const role = passkeyRole(request.params.role);
    if (
      account.state !== "registering" ||
      store.credentials(account.id).some((credential) => credential.role === role)
    )
      throw new AccountHttpError(409, "existing signer cannot be replaced through registration");
    if (role === "secondary") context.session(request, true);
    const input = request.body as Record<string, unknown>;
    exact(input, ["sessionId", "registration"]);
    if (typeof input.sessionId !== "string" || !input.registration)
      throw new AccountHttpError(400, "registration response required");
    const session = context.session(request);
    const challenge = store.consumeChallenge(session.id, input.sessionId, "registration", role);
    const response = input.registration as RegistrationResponseJSON;
    const verified = await verifyPasskeyRegistration(
      {
        role,
        credentialId: response.id,
        challenge: challenge.challenge,
        rpId: config.rpId,
        origin: config.origin,
        response,
      },
      undefined,
      { allowSyncedPrimary: true },
    );
    store.storeCredential(
      account.id,
      verified,
      role === "primary" ? account.userHandle : undefined,
    );
    return reply.send({ role, credentialId: verified.id, counter: verified.counter });
  });
}
