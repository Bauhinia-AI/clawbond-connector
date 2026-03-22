import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import { WebSocketServer } from "ws";

import { clawbondPlugin } from "../src/channel.ts";
import { resolveAccount } from "../src/config.ts";
import { CredentialStore } from "../src/credential-store.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-bootstrap-e2e-"));
  const pendingSessionToken = "agent_jwt_pending";
  const boundSessionToken = "agent_jwt_bound";
  const persistedAgent = {
    agentId: "agent_1001",
    agentName: "Galaxy QA Claw",
    secretKey: "secret_1001",
    bindCode: "BIND1234"
  };
  const refreshBodies: Array<{ agent_id?: string; secret_key?: string }> = [];
  const seenStatuses: Array<Record<string, unknown>> = [];
  const meTokens: string[] = [];
  let bindStatusChecks = 0;
  let wsToken = "";

  const store = new CredentialStore(stateRoot);
  await store.save("default", {
    platform_base_url: "http://placeholder",
    agent_access_token: pendingSessionToken,
    agent_id: persistedAgent.agentId,
    agent_name: persistedAgent.agentName,
    secret_key: persistedAgent.secretKey,
    bind_code: persistedAgent.bindCode,
    binding_status: "pending"
  });

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/auth/agent/refresh") {
      const body = (await readJsonBody(req)) as { agent_id?: string; secret_key?: string };
      refreshBodies.push(body);
      assert.equal(body.agent_id, persistedAgent.agentId);
      assert.equal(body.secret_key, persistedAgent.secretKey);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: { access_token: boundSessionToken },
          message: "success"
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/me") {
      const auth = req.headers.authorization;
      meTokens.push(String(auth ?? ""));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data:
            auth === `Bearer ${boundSessionToken}`
              ? {
                  id: persistedAgent.agentId,
                  name: persistedAgent.agentName,
                  user_id: "user_001",
                  bind_code: "BIND5678"
                }
              : {
                  id: persistedAgent.agentId,
                  name: persistedAgent.agentName,
                  user_id: null,
                  bind_code: persistedAgent.bindCode
                },
          message: "success"
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/bind-status") {
      assert.equal(req.headers.authorization, `Bearer ${pendingSessionToken}`);
      bindStatusChecks += 1;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data:
            bindStatusChecks >= 3
              ? { bound: true, user_id: "user_001", username: "alice" }
              : { bound: false },
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

    wsToken = url.searchParams.get("token") ?? "";
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve bootstrap test server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  await store.save("default", {
    platform_base_url: baseUrl,
    agent_access_token: pendingSessionToken,
    agent_id: persistedAgent.agentId,
    agent_name: persistedAgent.agentName,
    secret_key: persistedAgent.secretKey,
    bind_code: persistedAgent.bindCode,
    binding_status: "pending"
  });

  const cfg = {
    channels: {
      clawbond: {
        enabled: true,
        serverUrl: baseUrl,
        inviteWebBaseUrl: "https://dev.clawbond.ai/invite",
        stateRoot,
        bindStatusPollIntervalMs: 25
      }
    }
  };

  const account = resolveAccount(cfg, "default");
  assert.equal(account.bootstrapEnabled, true);
  assert.equal(account.agentId, persistedAgent.agentId);
  assert.equal(account.runtimeToken, pendingSessionToken);
  assert.equal(account.bindingStatus, "pending");

  const stubChannelRuntime = {
    routing: {
      resolveAgentRoute: ({ peer }: { peer: { id: string } }) => ({
        agentId: "local-openclaw-agent",
        sessionKey: `channel:clawbond:peer:${peer.id}`
      })
    },
    session: {
      resolveStorePath: () => "/tmp/clawbond-bootstrap-register-e2e",
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
      seenStatuses.push({ ...next });
    }
  });

  if (!runPromise) {
    throw new Error("clawbondPlugin.gateway.startAccount is unavailable");
  }

  try {
    await waitFor(() => wsToken === boundSessionToken, 5000);

    const stored = new CredentialStore(stateRoot).loadSync(account.accountId);
    assert.ok(stored, "expected persisted credentials to be updated");
    assert.equal(stored?.credentials.agent_id, persistedAgent.agentId);
    assert.equal(stored?.credentials.agent_access_token, boundSessionToken);
    assert.equal(stored?.credentials.binding_status, "bound");
    assert.equal(stored?.credentials.owner_user_id, "user_001");
    assert.equal(stored?.credentials.bind_code, "BIND5678");

    const resolvedAfterBootstrap = resolveAccount(cfg, account.accountId);
    assert.equal(resolvedAfterBootstrap.agentId, persistedAgent.agentId);
    assert.equal(resolvedAfterBootstrap.runtimeToken, boundSessionToken);
    assert.equal(resolvedAfterBootstrap.bindingStatus, "bound");
    assert.equal(resolvedAfterBootstrap.bindCode, "BIND5678");

    assert.equal(refreshBodies.length, 1);
    assert.deepEqual(meTokens, [
      `Bearer ${pendingSessionToken}`,
      `Bearer ${boundSessionToken}`
    ]);
    assert.equal(bindStatusChecks, 3);

    const phases = seenStatuses.map((status) => String(status.phase ?? ""));
    assert.ok(phases.includes("waiting_for_bind"));
    assert.ok(phases.includes("bound"));
    assert.ok(phases.includes("connected"));
    assert.ok(!phases.includes("registering"));

    const waitingStatus = seenStatuses.find((status) => status.phase === "waiting_for_bind") ?? {};
    assert.equal(waitingStatus.bindingStatus, "pending");
    assert.equal(waitingStatus.bindCode, persistedAgent.bindCode);
    assert.equal(waitingStatus.inviteUrl, "https://dev.clawbond.ai/invite/BIND1234");

    console.log("bootstrap registration-recovery E2E passed");
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

  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for registration recovery result"));
        return;
      }

      setTimeout(tick, 25);
    };

    tick();
  });
}

await main();
