import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const uiPort = 15180;
const rpcPort = 18547;
const baseURL = `http://localhost:${uiPort}`;

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  reporter: [["list", { printSteps: true }]],
  timeout: 240_000,
  expect: { timeout: 15_000 },
  use: { browserName: "chromium", baseURL },
  webServer: {
    command: [
      "./node_modules/.bin/hardhat compile",
      "node ../../apps/static-wallet/scripts/artifacts.cjs",
      "node -r ts-node/register/transpile-only scripts/static-wallet/local.cjs --wallet --e2e",
    ].join(" && "),
    cwd: resolve(import.meta.dirname, "../../packages/core"),
    env: {
      HARDHAT_NETWORK: "hardhat",
      STATIC_WALLET_UI_PORT: String(uiPort),
      STATIC_WALLET_RPC_PORT: String(rpcPort),
      STATIC_WALLET_PUBLIC_DIR: resolve(
        import.meta.dirname,
        "node_modules/.cache/wallet-e2e/public",
      ),
    },
    url: baseURL + "/local.json",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
