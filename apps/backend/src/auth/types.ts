import type { AccountSession, NewAccountSession } from "../accounts/types";

export type AuthSessionContext = Readonly<{
	token: string;
	session: AccountSession;
}>;

/** The HTTP adapter installs a replacement before projecting or returning the response. */
export type AuthSessionAction = Readonly<{
	session: AccountSession;
	replacement?: NewAccountSession;
}>;
