import { loadBackendConfig } from "./config";
import { createBackendHandlers, type BackendPreparation } from "./handlers";
import { SubmissionJournal } from "./journal";
import { createConfiguredAutomaticPwaProvisioner, type AutomaticPwaProvisioner } from "./provisioner";
import { createBackendServer, sanitizeBackendMessage, type BackendServer } from "./server";
import { PwaSubmissionService, SEPOLIA_USDC_ADDRESS, type BackendPreparedSubmission, type PwaSubmissionServiceOptions } from "./vault";
import { createConfiguredSubmissionRuntime } from "./submission-runtime";

export type ConfiguredSubmissionRuntime = Readonly<{
  prepare: BackendPreparation;
  revalidate: PwaSubmissionServiceOptions["revalidate"];
  deriveOuterHash: PwaSubmissionServiceOptions["deriveOuterHash"];
  broadcast: PwaSubmissionServiceOptions["broadcast"];
  reconcile: PwaSubmissionServiceOptions["reconcile"];
  discard?: PwaSubmissionServiceOptions["discard"];
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
  const configuredProvisioner: AutomaticPwaProvisioner = provisioner ?? (config.id === "local"
    ? await createConfiguredAutomaticPwaProvisioner(config)
    : Object.freeze({ provision: () => Promise.reject(new Error("automatic PWA provisioning is unavailable outside BACKEND_PROFILE=local")) }));
  let handlers: ReturnType<typeof createBackendHandlers>;
  const runtime = configuredProvisioner.historicalVault ? undefined : submissionRuntime ?? (config.id === "local" ? createConfiguredSubmissionRuntime(config, () => handlers?.vaultRecord()) : undefined);
  const service = runtime ? new PwaSubmissionService({
    journal: new SubmissionJournal(config.journalPath),
    revalidate: runtime.revalidate,
    deriveOuterHash: runtime.deriveOuterHash,
    broadcast: runtime.broadcast,
    reconcile: runtime.reconcile,
    ...(runtime.discard ? { discard: runtime.discard } : {}),
    verifyApproval: async (role, prepared: BackendPreparedSubmission, assertion) => {
      if (!prepared.safeTxHash) throw new Error("signed submission is missing its Safe transaction hash");
      const verified = await handlers.verifyApproval(prepared.safeTxHash, { role, assertion });
      return Object.freeze({ role, payload: verified.payload });
    },
  }) : undefined;
  handlers = createBackendHandlers({
    config, usdc: SEPOLIA_USDC_ADDRESS, provisioner: configuredProvisioner,
    ...(service && runtime ? {
      prepareTransfer: async (input) => service.prepare(await runtime.prepare(input)),
      submit: async ({ id, body }) => service.submit(id, body as never),
      submission: async ({ id }) => service.status(id),
    } : {}),
  });
  // Only a fully verified seven-receipt recovery may hydrate an account at
  // startup. Its executor has no missing transaction and cannot broadcast.
  if (!configuredProvisioner.historicalVault && configuredProvisioner.completedRecoveryReady) await handlers.autoProvisionVault({});
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
