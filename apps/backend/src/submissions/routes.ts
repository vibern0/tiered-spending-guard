import type { FastifyInstance } from "fastify";
import type { AccountGateway } from "../accounts/types";
import { submissionId, type AccountRouteContext } from "../http/security";

import { object, ref, routeSchema, string } from "../http/schema";

type SubmissionParams = Readonly<{ id: string }>;

export function registerAccountSubmissionRoutes(
	fastify: FastifyInstance,
	transactions: Pick<AccountGateway, "prepare" | "submit" | "status">,
	context: AccountRouteContext,
): void {
	fastify.post(
		"/v1/submissions/prepare",
		{
			schema: routeSchema({
				tag: "Submissions",
				summary: "Prepare a closed vault intent",
				description:
					"Derives and verifies the exact intent without broadcasting. Amounts use token base units. Account and session own the prepared attempt.",
				access: "authenticated",
				body: ref("Prepare"),
				response: ref("Prepared"),
			}),
		},
		async (request, reply) => {
			const session = context.session(request, true);
			const account = context.account(request);
			return reply.send(await transactions.prepare(account.id, session.id, request.body));
		},
	);

	fastify.post<{ Params: SubmissionParams }>(
		"/v1/submissions/:id/submit",
		{
			schema: routeSchema({
				tag: "Submissions",
				summary: "Approve or execute the exact prepared submission",
				description:
					"Fresh exact passkey approvals precede bounded signing and one broadcast. role=none grants no new approval.",
				access: "authenticated",
				params: object({ id: string }),
				body: ref("Submit"),
				response: ref("Submission"),
			}),
		},
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

	fastify.get<{ Params: SubmissionParams }>(
		"/v1/submissions/:id",
		{
			schema: routeSchema({
				tag: "Submissions",
				summary: "Read and reconcile submission status",
				description: "Account-scoped receipt observation never signs or broadcasts.",
				access: "authenticated",
				params: object({ id: string }),
				response: ref("Submission"),
			}),
		},
		async (request, reply) => {
			context.session(request, true);
			const account = context.account(request);
			return reply.send(
				await transactions.status(account.id, submissionId(request.params.id)),
			);
		},
	);
}
