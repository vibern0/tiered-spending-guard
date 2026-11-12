import type { FastifyBaseLogger } from "fastify";

export type BackendServerOptions = Readonly<{ logger?: FastifyBaseLogger }>;
