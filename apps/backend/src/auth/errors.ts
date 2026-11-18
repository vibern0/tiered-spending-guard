export class AccountHttpError extends Error {
	/** Attach an intentional HTTP status to an account-authentication error for route-level handling. */
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
