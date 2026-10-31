import { loadBackendConfig } from "./config";
import { createBackendHandlers } from "./handlers";
import { createConfiguredReviewedPwaProvisioner, type ReviewedPwaProvisioner } from "./provisioner";
import { createBackendServer, type BackendServer } from "./server";
import { SEPOLIA_USDC_ADDRESS } from "./vault";

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

export async function createConfiguredBackend(provisioner?: ReviewedPwaProvisioner, configured?: ReturnType<typeof loadBackendConfig>): Promise<BackendServer> {
  const config = configured ?? loadBackendConfig();
  return startBackend(config, createBackendHandlers({ config, usdc: SEPOLIA_USDC_ADDRESS, provisioner: provisioner ?? createConfiguredReviewedPwaProvisioner(config) }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void createConfiguredBackend().catch((error: unknown) => {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : "backend startup failed");
  });
}
