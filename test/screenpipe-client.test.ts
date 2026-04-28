import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ScreenpipeClient,
  ScreenpipeHttpError,
} from "../src/screenpipe/client.js";

describe("screenpipe client health", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      ),
    );
  });

  it("returns degraded /health payloads even when Screenpipe responds with 503", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: "degraded",
          status_code: 503,
          frame_status: "not_started",
          audio_status: "disabled",
          message: "some systems are not healthy: vision",
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const client = new ScreenpipeClient(`http://127.0.0.1:${address.port}`);

    await expect(client.health()).resolves.toEqual({
      status: "degraded",
      status_code: 503,
      frame_status: "not_started",
      audio_status: "disabled",
      message: "some systems are not healthy: vision",
    });
  });

  it("still throws when /health returns a non-json server error", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, {
        "Content-Type": "text/plain",
      });
      res.end("server overloaded");
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const client = new ScreenpipeClient(`http://127.0.0.1:${address.port}`);

    await expect(client.health()).rejects.toBeInstanceOf(ScreenpipeHttpError);
  });

  it("sends a bearer token when Screenpipe API auth is configured", async () => {
    let authorization: string | undefined;
    const server = createServer((req, res) => {
      authorization = req.headers.authorization;
      res.writeHead(200, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          data: [],
          pagination: {
            limit: 1,
            offset: 0,
            total: 0,
          },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const client = new ScreenpipeClient(`http://127.0.0.1:${address.port}`, {
      apiToken: "local-token",
    });

    await client.search({ content_type: "ocr", limit: 1 });

    expect(authorization).toBe("Bearer local-token");
  });
});
