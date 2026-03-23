import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { clawbondPlugin } from "../src/channel.ts";
import {
  loadClawBondActivitySnapshot,
  loadClawBondPendingMainInboxSnapshot
} from "../src/clawbond-assist.ts";
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
        agentName: "Polling Test Agent",
        bindingStatus: "bound",
        notificationsEnabled: true,
        notificationApiUrl: `http://127.0.0.1:${address.port}`,
        notificationAuthToken: "agent_jwt_test",
        notificationPollIntervalMs: 100,
        visibleMainSessionNotes: false
      }
    }
  };

  const account = resolveAccount(cfg, "default");

  setClawBondRuntime({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
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
    channelRuntime: undefined,
    getStatus: () => ({ accountId: account.accountId }),
    setStatus: () => undefined
  });

  if (!runPromise) {
    throw new Error("clawbondPlugin.gateway.startAccount is unavailable");
  }

  const completion = waitFor(
    async () => {
      const pendingInbox = loadClawBondPendingMainInboxSnapshot(cfg);
      if (!pendingInbox || pendingInbox.items.length !== 1) {
        return false;
      }
      const activitySnapshot = loadClawBondActivitySnapshot(cfg);
      if (
        !activitySnapshot?.recentEntries.some(
          (entry) => entry.event === "main_run_requested" && entry.traceId === "notification:1001"
        )
      ) {
        return false;
      }

      return true;
    },
    5000
  );

  try {
    await wsConnected;
    await completion;

    assert.equal(readIds.length, 0);

    const pendingInbox = loadClawBondPendingMainInboxSnapshot(cfg);
    assert.ok(pendingInbox);
    assert.equal(pendingInbox?.items.length, 1);
    assert.equal(pendingInbox?.items[0]?.notificationId, "1001");
    assert.equal(pendingInbox?.items[0]?.traceId, "notification:1001");
    assert.equal(pendingInbox?.items[0]?.deliveryPath, "notification_polling");

    const activitySnapshot = loadClawBondActivitySnapshot(cfg);
    assert.ok(activitySnapshot);
    assert.equal(
      activitySnapshot?.recentEntries.some(
        (entry) => entry.event === "inbound_received" && entry.traceId === "notification:1001"
      ),
      true
    );
    assert.equal(
      activitySnapshot?.recentEntries.some(
        (entry) => entry.event === "main_inbox_queued" && entry.traceId === "notification:1001"
      ),
      true
    );
    assert.equal(
      activitySnapshot?.recentEntries.some(
        (entry) => entry.event === "main_run_requested" && entry.traceId === "notification:1001"
      ),
      true
    );
    assert.equal(activitySnapshot?.pendingTraces[0]?.deliveryPath, "notification_polling");

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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for notification polling result");
}

await main();
