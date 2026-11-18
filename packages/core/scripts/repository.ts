import { resolve } from "node:path";

/** Locate this workspace from the operating tools, independent of the caller's working directory. */
export function repositoryRoot(): string {
  return resolve(__dirname, "../../..");
}
