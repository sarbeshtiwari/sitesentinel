import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import { randomUUID } from "node:crypto";
import { createLogger } from "@wim/logger";
import { AppModule } from "./app.module.js";
import { loadEnv } from "./config/env.js";

/** Build the API application (used by main.ts and the integration tests). */
export async function createApp(): Promise<NestFastifyApplication> {
  const env = loadEnv();
  const adapter = new FastifyAdapter({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    genReqId: () => `req_${randomUUID().replace(/-/g, "")}`,
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: env.NODE_ENV === "test" ? false : ["error", "warn"],
  });
  const fastify = app.getHttpAdapter().getInstance();
  const log = createLogger("api");
  fastify.addHook("onResponse", (req, reply, done) => {
    // Structured access log: no headers, no bodies, no query strings (which may carry tokens).
    log.info({ requestId: req.id, method: req.method, route: req.routeOptions.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request");
    done();
  });
  await app.register(fastifyCookie as never);
  await app.register(fastifyHelmet as never, {
    // JSON API: nothing may be framed or executed from responses.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-origin" },
    hsts: env.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  } as never);
  fastify.addHook("onSend", (_req, reply, payload, done) => {
    if (!reply.hasHeader("cache-control")) reply.header("Cache-Control", "no-store");
    done(null, payload);
  });
  app.enableShutdownHooks();
  await app.init();
  await fastify.ready();
  return app;
}
