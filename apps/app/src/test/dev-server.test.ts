import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { expect, it } from "vitest";

const appRoot = process.cwd();

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a local test port");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = once(child, "exit");
  if (process.platform === "win32") child.kill("SIGTERM");
  else process.kill(-child.pid, "SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
    await exited;
  }
}

it("serves the wallet root through the real pnpm dev command", async () => {
  const port = await reserveFreePort();
  const child = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["dev", "--port", String(port)],
    {
      cwd: appRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, VITE_BACKEND_ORIGIN: "http://localhost:8787" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        const check = () => output.includes("Local:") && resolve();
        child.stdout?.on("data", check);
        child.stderr?.on("data", check);
      }),
      once(child, "exit").then(([code]) => {
        throw new Error(`pnpm dev exited before startup with code ${String(code)}\n${output}`);
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`pnpm dev timed out\n${output}`)), 15_000),
      ),
    ]);

    const response = await fetch(`http://localhost:${port}/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!DOCTYPE html>");
  } finally {
    await stopProcess(child);
  }
}, 20_000);
