import type { FastifyInstance } from "fastify";
import type { TransactionService } from "../services/transaction-service";
import { submissionId, type AccountRouteContext } from "./account-context";

type SubmissionParams = Readonly<{ id: string }>;

export function registerAccountSubmissionRoutes(
  fastify: FastifyInstance,
  transactions: TransactionService,
  context: AccountRouteContext,
): void {
  fastify.post("/v1/submissions/prepare", async (request, reply) => {
    const session = context.session(request, true);
    const account = context.account(request);
    return reply.send(await transactions.prepare(account.id, session.id, request.body));
  });

  fastify.post<{ Params: SubmissionParams }>(
    "/v1/submissions/:id/submit",
    async (request, reply) => {
      const session = context.session(request, true);
      const account = context.account(request);
      return reply.send(
        await transactions.submit(
          account.id,
          session.id,
          submissionId(request.params.id),
          request.body,
        ),
      );
    },
  );

  fastify.get<{ Params: SubmissionParams }>("/v1/submissions/:id", async (request, reply) => {
    context.session(request, true);
    const account = context.account(request);
    return reply.send(await transactions.find(account.id, submissionId(request.params.id)));
  });
}
