import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { clawbondPlugin } from "../src/channel.ts";
import { resolveAccount } from "../src/config.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-reconnect-refresh-e2e-"));
  const initialToken = "agent_jwt_initial";
  const refreshedToken = "agent_jwt_reconnect";
  const refreshBodies: Array<{ agent_id?: string; secret_key?: string }> = [];
  const wsTokens: string[] = [];

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/auth/agent/refresh") {
      const body = (await readJsonBody(req)) as { agent_id?: string; secret_key?: string };
      refreshBodies.push(body);
      assert.equal(body.agent_id, "agent_2001");
      assert.equal(body.secret_key, "secret_2001");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: { access_token: refreshedToken },
          message: "success"
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/bind-status") {
      assert.match(String(req.headers.authorization ?? ""), /^Bearer /);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: { bound: true, user_id: "user_001", username: "alice" },
          message: "success"
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/me") {
      assert.match(String(req.headers.authorization ?? ""), /^Bearer /);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: {
            id: "agent_2001",
            name: "Reconnect QA Claw",
            user_id: "user_001",
            bind_code: "BIND2001"
          },
          message: "success"
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 404, data: null, message: "not found" }));
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve reconnect-refresh test server address");
  }

  const reconnected = new Promise<void>((resolve, reject) => {
    wss.on("connection", (socket, req) => {
      try {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const token = requestUrl.searchParams.get("token") ?? "";
        wsTokens.push(token);

        if (wsTokens.length === 1) {
          assert.equal(token, initialToken);
          setTimeout(() => {
            socket.close(4002, "JWT expired");
          }, 20);
          return;
        }

        assert.equal(token, refreshedToken);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

  const cfg = {
    channels: {
      clawbond: {
        enabled: true,
        serverUrl: `http://127.0.0.1:${address.port}`,
        stateRoot,
        bootstrapEnabled: false,
        runtimeToken: initialToken,
        agentId: "agent_2001",
        agentName: "Reconnect QA Claw",
        secretKey: "secret_2001",
        bindCode: "BIND2001",
        bindingStatus: "bound",
        bindStatusPollIntervalMs: 10_000
      }
    }
  };

  const account = resolveAccount(cfg, "default");
  const stubChannelRuntime = {
    routing: {
      resolveAgentRoute: ({ peer }: { peer: { id: string } }) => ({
        agentId: "local-openclaw-agent",
        sessionKey: `channel:clawbond:peer:${peer.id}`
      })
    },
    session: {
      resolveStorePath: () => "/tmp/clawbond-reconnect-refresh-e2e",
      readSessionUpdatedAt: () => undefined,
      recordInboundSession: async () => undefined
    },
    reply: {
      finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
      resolveEnvelopeFormatOptions: () => undefined,
      formatAgentEnvelope: ({ body }: { body: string }) => body,
      dispatchReplyWithBufferedBlockDispatcher: async () => undefined
    }
  };

  setClawBondRuntime({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    channel: stubChannelRuntime
  });

  const abortController = new AbortController();
  const runPromise = clawbondPlugin.gateway?.startAccount?.({
    cfg,
    accountId: account.accountId,
    account,
    abortSignal: abortController.signal,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    },
    channelRuntime: stubChannelRuntime,
    getStatus: () => ({ accountId: account.accountId }),
    setStatus: () => undefined
  });

  if (!runPromise) {
    throw new Error("clawbondPlugin.gateway.startAccount is unavailable");
  }

  try {
    await reconnected;

    assert.deepEqual(refreshBodies, [
      {
        agent_id: "agent_2001",
        secret_key: "secret_2001"
      }
    ]);
    assert.deepEqual(wsTokens, [initialToken, refreshedToken]);

    console.log("reconnect-refresh E2E passed");
  } finally {
    abortController.abort();
    await runPromise;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function readJsonBody(req: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

await main();
