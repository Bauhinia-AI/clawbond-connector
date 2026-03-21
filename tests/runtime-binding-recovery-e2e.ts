import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { clawbondPlugin } from "../src/channel.ts";
import { resolveAccount } from "../src/config.ts";
import { CredentialStore } from "../src/credential-store.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-runtime-binding-recovery-e2e-"));
  const initialToken = "agent_jwt_bound_initial";
  const reboundToken = "agent_jwt_bound_rebound";
  const refreshBodies: Array<{ agent_id?: string; secret_key?: string }> = [];
  const statusPhases: string[] = [];
  const wsTokens: string[] = [];
  let bindStatusChecks = 0;

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/auth/agent/refresh") {
      const body = (await readJsonBody(req)) as { agent_id?: string; secret_key?: string };
      refreshBodies.push(body);
      assert.equal(body.agent_id, "agent_3001");
      assert.equal(body.secret_key, "secret_3001");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: { access_token: reboundToken },
          message: "success"
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/bind-status") {
      bindStatusChecks += 1;
      assert.match(String(req.headers.authorization ?? ""), /^Bearer /);

      let data: Record<string, unknown>;
      if (bindStatusChecks === 1) {
        data = { bound: true, user_id: "user_001", username: "alice" };
      } else if (bindStatusChecks < 5) {
        data = { bound: false };
      } else {
        data = { bound: true, user_id: "user_001", username: "alice" };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 200, data, message: "success" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/me") {
      const auth = String(req.headers.authorization ?? "");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data:
            auth === `Bearer ${reboundToken}`
              ? {
                  id: "agent_3001",
                  name: "Recovery QA Claw",
                  user_id: "user_001",
                  bind_code: "BOUND3002"
                }
              : {
                  id: "agent_3001",
                  name: "Recovery QA Claw",
                  user_id: null,
                  bind_code: "REBIND3001"
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
    throw new Error("Failed to resolve runtime-binding-recovery test server address");
  }

  const reboundConnected = new Promise<void>((resolve, reject) => {
    wss.on("connection", (_socket, req) => {
      try {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const token = requestUrl.searchParams.get("token") ?? "";
        wsTokens.push(token);

        if (wsTokens.length === 1) {
          assert.equal(token, initialToken);
          return;
        }

        assert.equal(token, reboundToken);
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
        agentId: "agent_3001",
        agentName: "Recovery QA Claw",
        secretKey: "secret_3001",
        bindCode: "BOUND3001",
        bindingStatus: "bound",
        bindStatusPollIntervalMs: 25
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
      resolveStorePath: () => "/tmp/clawbond-runtime-binding-recovery-e2e",
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

  let latestStatus: Record<string, unknown> = { accountId: account.accountId };
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
    getStatus: () => latestStatus,
    setStatus: (next) => {
      latestStatus = next;
      statusPhases.push(String(next.phase ?? ""));
    }
  });

  if (!runPromise) {
    throw new Error("clawbondPlugin.gateway.startAccount is unavailable");
  }

  try {
    await reboundConnected;

    const stored = new CredentialStore(stateRoot).loadSync(account.accountId);
    assert.ok(stored, "expected recovered credentials to be persisted");
    assert.equal(stored?.credentials.agent_access_token, reboundToken);
    assert.equal(stored?.credentials.binding_status, "bound");
    assert.equal(stored?.credentials.bind_code, "BOUND3002");
    assert.equal(stored?.credentials.owner_user_id, "user_001");

    assert.deepEqual(refreshBodies, [
      {
        agent_id: "agent_3001",
        secret_key: "secret_3001"
      }
    ]);
    assert.deepEqual(wsTokens, [initialToken, reboundToken]);
    assert.ok(statusPhases.includes("waiting_for_bind"));
    assert.equal(latestStatus.bindingStatus, "bound");

    console.log("runtime-binding-recovery E2E passed");
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
