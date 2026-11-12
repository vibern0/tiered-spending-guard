import { parseProfileArguments, profileVerification } from "./profile-verification";

const HELP =
	"Usage: npm run backend:profile:verification -- --account-directory /absolute/external/account [--output-directory /new/external/directory] [--evidence-config /private/external/readers.json] [--samples 1..5]\nRead-only verification-core profile. No signer credentials, signing or broadcast. Outputs summary.json, verification.trace.json and verification.cpuprofile outside the repository.";
if (process.argv.slice(2).includes("--help")) console.log(HELP);
else
	void (async () => {
		const report = await profileVerification(parseProfileArguments(process.argv.slice(2)));
		console.log(JSON.stringify(report, null, 2));
	})().catch((error: unknown) => {
		process.exitCode = 1;
		if (error && typeof error === "object" && "outputDirectory" in error)
			console.error(
				JSON.stringify({ outputDirectory: error.outputDirectory, completed: false }),
			);
		console.error(
			"Read-only verification profiling failed closed. Check the command arguments, completed deployment evidence and local diagnostic output; no transaction was signed or broadcast.",
		);
	});
