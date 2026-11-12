import type { AccountGateway } from "../account-server";

type TransactionGateway = Pick<AccountGateway, "prepare" | "submit" | "status">;

export class TransactionService {
	constructor(private readonly gateway: TransactionGateway) {}

	prepare(accountId: string, sessionId: string, body: unknown): Promise<unknown> {
		return this.gateway.prepare(accountId, sessionId, body);
	}

	submit(accountId: string, sessionId: string, id: string, body: unknown): Promise<unknown> {
		return this.gateway.submit(accountId, sessionId, id, body);
	}

	find(accountId: string, id: string): Promise<unknown> {
		return this.gateway.status(accountId, id);
	}
}
