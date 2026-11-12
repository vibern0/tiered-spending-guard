import type { FastifyInstance } from "fastify";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { BackendConfig } from "../config";
import type { AccountStore } from "../account-store";
import type { AccountGateway } from "../account-server";
import type { AccountService } from "../services/account-service";
import { verifyPasskeyLogin, verifyPasskeyRebind } from "../webauthn";
import { AccountHttpError, exact, type AccountRouteContext } from "./account-context";

export function registerAccountAuthRoutes(
  fastify: FastifyInstance,
  config: BackendConfig,
  store: AccountStore,
  gateway: AccountGateway,
  accounts: AccountService,
  context: AccountRouteContext,
): void {
  fastify.get("/v1/auth/session", async (request, reply) =>
    reply.send(await accounts.project(context.state(request).session)),
  );

  fastify.post("/v1/auth/setup", async (request, reply) => {
    const input = request.body as Record<string, unknown>;
    exact(input, []);
    const current = context.state(request).session;
    if (current?.authenticated)
      throw new AccountHttpError(409, "sign out before creating another account");
    if (current?.accountId) return reply.send(await accounts.project(current));
    const created = accounts.create();
    context.replaceSession(request, created);
    context.setCookie(reply, created.token);
    return reply.send(await accounts.project(created));
  });

  fastify.post("/v1/auth/login/options", async (request, reply) => {
    const input = request.body as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => key !== "accountId") ||
      (input.accountId !== undefined && typeof input.accountId !== "string")
    )
      throw new AccountHttpError(400, "unsupported login fields");
    let state = context.state(request);
    if (!state.session) {
      const created = store.createSession();
      context.replaceSession(request, created);
      context.setCookie(reply, created.token);
      state = context.state(request);
    }
    const session = state.session!;
    const challenge = store.createChallenge(
      session.id,
      input.accountId ? `login:${input.accountId}` : "login",
    );
    const target = input.accountId ? store.account(input.accountId as string) : undefined;
    return reply.send({
      sessionId: challenge.id,
      challenge: challenge.challenge,
      rpId: config.rpId,
      origin: config.origin,
      userVerification: "required",
      csrfToken: session.csrfToken,
      ...(target
        ? {
            accountId: target.id,
            credentialIds: store
              .credentials(target.id)
              .filter((credential) => credential.role === "primary")
              .map((credential) => credential.id),
          }
        : {}),
    });
  });

  fastify.post("/v1/auth/login/verify", async (request, reply) => {
    const input = request.body as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !["sessionId", "assertion", "accountId"].includes(key)) ||
      typeof input.sessionId !== "string" ||
      !input.assertion
    )
      throw new AccountHttpError(400, "login session and assertion required");
    const state = context.state(request);
    const session = context.session(request);
    const challenge = store.consumeChallenge(
      session.id,
      input.sessionId,
      input.accountId ? `login:${input.accountId}` : "login",
    );
    const assertion = input.assertion as AuthenticationResponseJSON;
    let credential = store.credential(assertion.id);
    if (!credential && gateway.legacyCoordinates) {
      const target = store.account(
        typeof input.accountId === "string" ? input.accountId : "legacy",
      );
      if (!target?.legacy) throw new AccountHttpError(400, "first passkey authentication failed");
      const coordinates = await gateway.legacyCoordinates(target.id);
      if (!coordinates) throw new AccountHttpError(400, "existing account proof unavailable");
      const verified = await verifyPasskeyRebind({
        role: "primary",
        coordinates,
        challenge: challenge.challenge,
        rpId: config.rpId,
        origin: config.origin,
        response: assertion,
      });
      store.storeCredential(target.id, verified);
      credential = store.credential(verified.id);
    } else {
      if (
        !credential ||
        credential.role !== "primary" ||
        (input.accountId !== undefined && credential.accountId !== input.accountId)
      )
        throw new AccountHttpError(400, "first passkey authentication failed");
      const next = await verifyPasskeyLogin({
        credential,
        response: assertion,
        challenge: challenge.challenge,
        rpId: config.rpId,
        origin: config.origin,
        userHandle: credential.userHandle,
        allowMissingUserHandle:
          session.accountId === credential.accountId || input.accountId === credential.accountId,
      });
      store.updateCounter(credential.id, credential.counter, next);
    }
    if (store.session(state.token)?.id !== session.id)
      throw new AccountHttpError(401, "sign-in session expired or revoked");
    const created = store.createSession(credential!.accountId, true);
    store.revokeSession(state.token);
    gateway.releaseSession?.(session.id);
    context.replaceSession(request, created);
    context.setCookie(reply, created.token);
    return reply.send(await accounts.project(created));
  });

  fastify.post("/v1/auth/logout", async (request, reply) => {
    const input = request.body as Record<string, unknown>;
    exact(input, []);
    const state = context.state(request);
    const session = context.session(request);
    store.revokeSession(state.token);
    gateway.releaseSession?.(session.id);
    context.clearCookie(reply);
    return reply.send({ authenticated: false });
  });
}
