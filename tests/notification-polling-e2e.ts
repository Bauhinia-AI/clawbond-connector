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
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-notification-polling-e2e-"));
  const notifications = [
    {
      id: "1001",
      sender_id: "human-001",
      sender_type: "user",
      content: "[学习任务]\n请学习这篇帖子并整理成报告。",
      is_read: false,
      created_at: "2026-03-18T10:00:00.000Z"
    }
  ];
  const readIds: string[] = [];
  const outboundNotifications: string[] = [];
  const inboundContexts: Array<Record<string, unknown>> = [];

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/api/agent/notifications") {
      assert.equal(req.headers.authorization, "Bearer agent_jwt_test");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: notifications,
          message: "success",
          pagination: { total: notifications.length, page: 1, page_size: 20, total_pages: 1 }
        }),
      );
      return;
    }

    if (req.method === "PATCH" && url.pathname === "/api/agent/notifications/1001/read") {
      assert.equal(req.headers.authorization, "Bearer agent_jwt_test");
      assert.equal(req.headers["content-type"], undefined);
      readIds.push("1001");
      notifications[0]!.is_read = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: { id: "1001", is_read: true }, message: "success" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/notifications/send") {
      assert.equal(req.headers.authorization, "Bearer agent_jwt_test");
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { content: string };
      outboundNotifications.push(body.content);

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 201, data: { ok: true }, message: "success" }));
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
    throw new Error("Failed to resolve test server address");
  }

  const wsConnected = new Promise<void>((resolve) => {
    wss.once("connection", (_socket, req) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      assert.equal(requestUrl.pathname, "/ws");
      assert.equal(requestUrl.searchParams.get("token"), "rt_test");
      resolve();
    });
  });

  const cfg = {
    channels: {
      clawbond: {
        enabled: true,
        serverUrl: `http://127.0.0.1:${address.port}/ws`,
        stateRoot,
        bootstrapEnabled: false,
        runtimeToken: "rt_test",
        agentId: "agent-local",
        notificationsEnabled: true,
        notificationApiUrl: `http://127.0.0.1:${address.port}`,
        notificationAuthToken: "agent_jwt_test",
        notificationPollIntervalMs: 100
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
      resolveStorePath: () => "/tmp/clawbond-notification-polling-e2e",
      readSessionUpdatedAt: () => undefined,
      recordInboundSession: async ({ ctx }: { ctx: Record<string, unknown> }) => {
        inboundContexts.push(ctx);
      }
    },
    reply: {
      finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
      resolveEnvelopeFormatOptions: () => undefined,
      formatAgentEnvelope: ({ body }: { body: string }) => body,
      dispatchReplyWithBufferedBlockDispatcher: async ({
        dispatcherOptions
      }: {
        dispatcherOptions: { deliver: (payload: { text: string }) => Promise<void> };
      }) => {
        await dispatcherOptions.deliver({
          text: "ACK:notification"
        });
      }
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

  const completion = waitFor(
    () => readIds.includes("1001") && outboundNotifications.includes("ACK:notification"),
    5000
  );

  try {
    await wsConnected;
    await completion;

    assert.equal(readIds.length, 1);
    assert.deepEqual(outboundNotifications, ["ACK:notification"]);
    assert.equal(inboundContexts.length, 1);

    const context = inboundContexts[0] ?? {};
    assert.equal(context.RawBody, "[学习任务]\n请学习这篇帖子并整理成报告。");
    assert.match(String(context.BodyForAgent ?? ""), /ClawBond notification/);
    assert.match(String(context.BodyForAgent ?? ""), /Notification ID: 1001/);
    assert.match(String(context.BodyForAgent ?? ""), /Sender type: user/);

    console.log("notification-polling E2E passed");
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

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for notification polling result"));
        return;
      }

      setTimeout(tick, 25);
    };

    tick();
  });
}

await main();
