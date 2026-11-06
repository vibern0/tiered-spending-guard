import { describe, expect, it } from "vitest";
import { loadWalletEnvironmentProfile } from "./environment-profile";

const localEnv = {
  VITE_WALLET_PROFILE: "local",
  VITE_APP_ORIGIN: "http://localhost:5173",
  VITE_WEBAUTHN_RP_ID: "localhost",
  VITE_BACKEND_ORIGIN: "http://localhost:8787",
};

const httpsEnv = {
  VITE_WALLET_PROFILE: "https",
  VITE_APP_ORIGIN: "https://vault.example",
  VITE_WEBAUTHN_RP_ID: "vault.example",
  VITE_BACKEND_ORIGIN: "https://relay.example",
};

describe("wallet environment profile", () => {
  it("loads only the exact localhost profile", () => {
    expect(loadWalletEnvironmentProfile(localEnv, "http://localhost:5173")).toEqual({
      id: "local",
      chainId: 11155111,
      appOrigin: "http://localhost:5173",
      rpId: "localhost",
      backendOrigin: "http://localhost:8787",
      credentials: "include",
    });
  });

  it("loads one exact stable HTTPS profile with credentialed backend requests", () => {
    expect(loadWalletEnvironmentProfile(httpsEnv, "https://vault.example")).toEqual({
      id: "https",
      chainId: 11155111,
      appOrigin: "https://vault.example",
      rpId: "vault.example",
      backendOrigin: "https://relay.example",
      credentials: "include",
    });
  });

  it.each([
    [
      "cookie hostname mismatch",
      { ...localEnv, VITE_BACKEND_ORIGIN: "http://127.0.0.1:8787" },
      "http://localhost:5173",
    ],
    ["observed hostname drift", httpsEnv, "https://preview.example"],
    [
      "wildcard origin",
      { ...httpsEnv, VITE_APP_ORIGIN: "https://*.example" },
      "https://vault.example",
    ],
    ["wildcard RP", { ...httpsEnv, VITE_WEBAUTHN_RP_ID: "*.example" }, "https://vault.example"],
    [
      "HTTP remote app",
      { ...httpsEnv, VITE_APP_ORIGIN: "http://vault.example" },
      "http://vault.example",
    ],
    [
      "embedded credentials",
      { ...httpsEnv, VITE_BACKEND_ORIGIN: "https://token@relay.example" },
      "https://vault.example",
    ],
    [
      "app path",
      { ...httpsEnv, VITE_APP_ORIGIN: "https://vault.example/app" },
      "https://vault.example",
    ],
    [
      "backend query",
      { ...httpsEnv, VITE_BACKEND_ORIGIN: "https://relay.example/?token=x" },
      "https://vault.example",
    ],
    [
      "origin fragment",
      { ...httpsEnv, VITE_APP_ORIGIN: "https://vault.example/#x" },
      "https://vault.example",
    ],
    [
      "IP RP",
      { ...httpsEnv, VITE_APP_ORIGIN: "https://192.0.2.1", VITE_WEBAUTHN_RP_ID: "192.0.2.1" },
      "https://192.0.2.1",
    ],
    [
      "app/RP mismatch",
      { ...httpsEnv, VITE_WEBAUTHN_RP_ID: "login.example" },
      "https://vault.example",
    ],
    [
      "local/HTTPS mix",
      { ...localEnv, VITE_BACKEND_ORIGIN: "https://relay.example" },
      "http://localhost:5173",
    ],
    ["unknown profile", { ...httpsEnv, VITE_WALLET_PROFILE: "preview" }, "https://vault.example"],
    [
      "preview host",
      {
        ...httpsEnv,
        VITE_APP_ORIGIN: "https://preview.vault.example",
        VITE_WEBAUTHN_RP_ID: "preview.vault.example",
      },
      "https://preview.vault.example",
    ],
  ])("rejects %s", (_name, env, observedOrigin) => {
    expect(() => loadWalletEnvironmentProfile(env, observedOrigin)).toThrow();
  });
});
