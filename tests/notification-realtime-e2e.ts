import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { createClawBondBeforePromptBuildHandler } from "../src/clawbond-prompt-hooks.ts";
import { resolveAccount } from "../src/config.ts";
import { CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE } from "../src/openclaw-cli.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-notification-realtime-e2e-"));
  const wakeDir = await mkdtemp(path.join(tmpdir(), "clawbond-openclaw-bin-"));
  const wakeLogPath = path.join(wakeDir, "wake.log");
  const fakeOpenClawPath = path.join(wakeDir, "openclaw");
  const originalOpenClawBin = process.env.CLAWBOND_OPENCLAW_BIN;
  process.env.CLAWBOND_OPENCLAW_BIN = fakeOpenClawPath;
  process.env.CLAWBOND_WAKE_LOG = wakeLogPath;

  await writeFile(
    fakeOpenClawPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$CLAWBOND_WAKE_LOG\""
    ].join("\n"),
    "utf-8"
  );
  await chmod(fakeOpenClawPath, 0o755);

  const readIds: string[] = [];
  let latestStatus: Record<string, unknown> = { accountId: "default" };

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/api/agent/notifications") {
      assert.equal(req.headers.authorization, "Bearer agent_jwt_test");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: [],
          message: "success",
          pagination: { total: 0, page: 1, page_size: 20, total_pages: 0 }
        })
      );
      return;
    }

    if (req.method === "PATCH" && url.pathname === "/api/agent/notifications/ws-1001/read") {
      assert.equal(req.headers.authorization, "Bearer agent_jwt_test");
      readIds.push("ws-1001");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 200, data: { id: "ws-1001", is_read: true }, message: "success" }));
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
    wss.once("connection", (ws, req) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      assert.equal(requestUrl.pathname, "/ws");
      assert.equal(requestUrl.searchParams.get("token"), "rt_test");

      ws.send(
        JSON.stringify({
          event: "notification",
          id: "ws-1001",
          sender_id: "human-001",
          sender_type: "user",
          noti_type: "learn",
          content: "[学习任务]\n请实时处理这条推送。",
          created_at: "2026-03-18T10:01:00.000Z"
        })
      );
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
        agentName: "Realtime Test Agent",
        notificationsEnabled: true,
        notificationApiUrl: `http://127.0.0.1:${address.port}`,
        notificationAuthToken: "agent_jwt_test",
        notificationPollIntervalMs: 10_000,
        bindingStatus: "bound",
        visibleMainSessionNotes: true
      }
    }
  };

  const account = resolveAccount(cfg, "default");
  setClawBondRuntime({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "agent-local",
          sessionKey: "agent:main:main"
        })
      },
      session: {
        resolveStorePath: () => stateRoot,
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => undefined
      },
      reply: {
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: async () => undefined,
        resolveEnvelopeFormatOptions: () => undefined,
        formatAgentEnvelope: ({ body }: { body: string }) => body
      }
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
    getStatus: () => latestStatus,
    setStatus: (next) => {
      latestStatus = { ...next };
    }
  });

  if (!runPromise) {
    throw new Error("clawbondPlugin.gateway.startAccount is unavailable");
  }

  const completion = waitFor(async () => {
    if (!readIds.includes("ws-1001")) {
      return false;
    }

    const pendingInbox = loadClawBondPendingMainInboxSnapshot(cfg);
    if (!pendingInbox || pendingInbox.items.length !== 1) {
      return false;
    }

    try {
      const wakeLog = await readFile(wakeLogPath, "utf-8");
        return (
          wakeLog.includes("gateway call chat.inject --params") &&
          wakeLog.includes("system event --mode now --text") &&
          !wakeLog.includes("gateway call chat.send --params") &&
          wakeLog.includes(CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE) &&
          wakeLog.includes(
            "New notification from user:human-001. Agent notified and handling now."
          ) &&
          !wakeLog.includes("Handling new notification from user:human-001 now.") &&
          !wakeLog.includes("New notification from user:human-001. Agent notified.") &&
          wakeLog.includes("notification from user:human-001.") &&
          !wakeLog.includes("notificationId: ws-1001") &&
          !wakeLog.includes("请实时处理这条推送。")
        );
      } catch {
        return false;
      }
  }, 5000);

  try {
    await wsConnected;
    await completion;

    assert.equal(readIds.length, 1);
    assert.equal(typeof latestStatus.lastInboundAt, "number");

    const pendingInbox = loadClawBondPendingMainInboxSnapshot(cfg);
    assert.ok(pendingInbox);
    assert.equal(pendingInbox?.items.length, 1);
    assert.equal(pendingInbox?.items[0]?.notificationId, "ws-1001");
    assert.equal(pendingInbox?.items[0]?.sourceKind, "notification");
    assert.equal(pendingInbox?.items[0]?.traceId, "notification:ws-1001");
    assert.equal(pendingInbox?.items[0]?.deliveryPath, "notification_realtime");

    const activitySnapshot = loadClawBondActivitySnapshot(cfg);
    assert.ok(activitySnapshot);
    assert.equal(
      activitySnapshot?.recentEntries.some(
        (entry) => entry.event === "inbound_received" && entry.traceId === "notification:ws-1001"
      ),
      true
    );
    assert.equal(
      activitySnapshot?.recentEntries.some(
        (entry) => entry.event === "main_inbox_queued" && entry.traceId === "notification:ws-1001"
      ),
      true
    );
    assert.equal(
      activitySnapshot?.recentEntries.some(
        (entry) => entry.event === "main_run_requested" && entry.traceId === "notification:ws-1001"
      ),
      true
    );
    assert.equal(activitySnapshot?.pendingTraces[0]?.traceId, "notification:ws-1001");
    assert.equal(activitySnapshot?.pendingTraces[0]?.deliveryPath, "notification_realtime");

    const hook = createClawBondBeforePromptBuildHandler({
      config: cfg,
      logger: { warn: () => undefined }
    });
    const hookResult = await hook(
      {
        prompt: "Read HEARTBEAT.md if it exists",
        messages: [`System: [2026-03-21 10:26 UTC] ${CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE}`]
      },
      {
        sessionId: "agent:main:main",
        sessionKey: "agent:main:main",
        trigger: "heartbeat",
        channelId: "web"
      }
    );
    assert.match(hookResult?.prependSystemContext ?? "", /ClawBond internal realtime payload/);
    assert.match(hookResult?.prependSystemContext ?? "", /notificationId: ws-1001/);
    assert.match(hookResult?.prependSystemContext ?? "", /请实时处理这条推送/);
    assert.doesNotMatch(hookResult?.prependContext ?? "", /ClawBond reminder \/ 消息提醒/);

    const activityAfterHook = loadClawBondActivitySnapshot(cfg);
    assert.equal(
      activityAfterHook?.recentEntries.some(
        (entry) => entry.event === "main_prompt_injected" && entry.traceId === "notification:ws-1001"
      ),
      true
    );

    const followupHookResult = await hook(
      { prompt: "what just arrived", messages: [] },
      { sessionId: "agent:main:main", sessionKey: "agent:main:main", trigger: "user", channelId: "web" }
    );
    assert.equal(followupHookResult?.prependContext, undefined);
    assert.equal(followupHookResult?.prependSystemContext, undefined);

    const staleHistoryFollowupHookResult = await hook(
      {
        prompt: "continue our local thread",
        messages: [
          `System: [2026-03-21 10:26 UTC] ${CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE}`,
          "Assistant: already processed the realtime wake"
        ]
      },
      { sessionId: "agent:main:main", sessionKey: "agent:main:main", trigger: "user", channelId: "web" }
    );
    assert.equal(staleHistoryFollowupHookResult?.prependContext, undefined);
    assert.equal(staleHistoryFollowupHookResult?.prependSystemContext, undefined);

    console.log("notification-realtime E2E passed");
  } finally {
    abortController.abort();
    await runPromise;
    delete process.env.CLAWBOND_WAKE_LOG;
    if (typeof originalOpenClawBin === "string") {
      process.env.CLAWBOND_OPENCLAW_BIN = originalOpenClawBin;
    } else {
      delete process.env.CLAWBOND_OPENCLAW_BIN;
    }

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
    await rm(wakeDir, { recursive: true, force: true });
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

  throw new Error("Timed out waiting for realtime notification result");
}

await main();
