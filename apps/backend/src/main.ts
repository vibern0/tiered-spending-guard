import { loadBackendConfig } from "./config";
import { createBackendHandlers, type BackendPreparation } from "./handlers";
import { SubmissionJournal } from "./journal";
import { createConfiguredAutomaticPwaProvisioner, type AutomaticPwaProvisioner } from "./provisioner";
import { createBackendServer, sanitizeBackendMessage, type BackendServer } from "./server";
import { PwaSubmissionService, SEPOLIA_USDC_ADDRESS, type BackendPreparedSubmission, type PwaSubmissionServiceOptions } from "./vault";

export type ConfiguredSubmissionRuntime = Readonly<{
  prepare: BackendPreparation;
  revalidate: PwaSubmissionServiceOptions["revalidate"];
  deriveOuterHash: PwaSubmissionServiceOptions["deriveOuterHash"];
  broadcast: PwaSubmissionServiceOptions["broadcast"];
  reconcile: PwaSubmissionServiceOptions["reconcile"];
}>;

export async function startBackend(config: Parameters<typeof createBackendServer>[0], handlers: Parameters<typeof createBackendServer>[1]): Promise<BackendServer> {
  const backend = createBackendServer(config, handlers);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    backend.server.once("error", onError);
    backend.server.listen(config.port, config.host, () => {
      backend.server.off("error", onError);
      resolve();
    });
  });
  return backend;
}

export async function createConfiguredBackend(provisioner?: AutomaticPwaProvisioner, configured?: ReturnType<typeof loadBackendConfig>, submissionRuntime?: ConfiguredSubmissionRuntime): Promise<BackendServer> {
  const config = configured ?? loadBackendConfig();
  const configuredProvisioner = provisioner ?? (config.id === "local"
    ? await createConfiguredAutomaticPwaProvisioner(config)
    : Object.freeze({ provision: () => Promise.reject(new Error("automatic PWA provisioning is unavailable outside BACKEND_PROFILE=local")) }));
  let handlers: ReturnType<typeof createBackendHandlers>;
  const service = submissionRuntime ? new PwaSubmissionService({
    journal: new SubmissionJournal(config.journalPath),
    revalidate: submissionRuntime.revalidate,
    deriveOuterHash: submissionRuntime.deriveOuterHash,
    broadcast: submissionRuntime.broadcast,
    reconcile: submissionRuntime.reconcile,
    verifyApproval: async (role, prepared: BackendPreparedSubmission, assertion) => {
      if (!prepared.safeTxHash) throw new Error("signed submission is missing its Safe transaction hash");
      const verified = await handlers.verifyApproval(prepared.safeTxHash, { role, assertion });
      return Object.freeze({ role, payload: verified.payload });
    },
  }) : undefined;
  handlers = createBackendHandlers({
    config, usdc: SEPOLIA_USDC_ADDRESS, provisioner: configuredProvisioner,
    ...(service && submissionRuntime ? {
      prepareTransfer: async (input) => service.prepare(await submissionRuntime.prepare(input)),
      submit: async ({ id, body }) => service.submit(id, body as never),
      submission: async ({ id }) => service.status(id),
    } : {}),
  });
  return startBackend(config, handlers);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void createConfiguredBackend()
    .then(() => console.log(JSON.stringify({ level: "info", code: "backend_started", stage: "startup", route: "http", message: "backend listening" })))
    .catch((error: unknown) => {
      process.exitCode = 1;
      console.error(JSON.stringify({ level: "error", code: "backend_startup_failed", stage: "startup", message: sanitizeBackendMessage(error) }));
    });
}
