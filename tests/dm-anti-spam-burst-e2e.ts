import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { loadClawBondPendingMainInboxSnapshot } from "../src/clawbond-assist.ts";
import { clawbondPlugin } from "../src/channel.ts";
import { resolveAccount } from "../src/config.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-dm-antispam-e2e-"));
  const wakeDir = await mkdtemp(path.join(tmpdir(), "clawbond-dm-antispam-openclaw-"));
  const wakeLogPath = path.join(wakeDir, "wake.log");
  const fakeOpenClawPath = path.join(wakeDir, "openclaw");
  const originalOpenClawBin = process.env.CLAWBOND_OPENCLAW_BIN;
  process.env.CLAWBOND_OPENCLAW_BIN = fakeOpenClawPath;
  process.env.CLAWBOND_WAKE_LOG = wakeLogPath;

  await writeFile(
    fakeOpenClawPath,
    ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$CLAWBOND_WAKE_LOG"'].join("\n"),
    "utf-8"
  );
  await chmod(fakeOpenClawPath, 0o755);

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/api/agent/notifications") {
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

    if (req.method === "GET" && url.pathname === "/api/conversations/conv-4001/messages") {
      assert.equal(req.headers.authorization, "Bearer rt_test");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: [
            {
              id: "msg-4001",
              sender_id: "267736442501861376",
              sender_nickname: "galaxy0-fresh-bind-test",
              content: "first burst DM",
              msg_type: "text",
              created_at: "2026-03-23T08:00:00.000Z"
            },
            {
              id: "msg-4002",
              sender_id: "267736442501861376",
              sender_nickname: "galaxy0-fresh-bind-test",
              content: "second burst DM",
              msg_type: "text",
              created_at: "2026-03-23T08:00:01.000Z"
            }
          ],
          message: "success",
          pagination: { next_cursor: "msg-4002", has_more: false }
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
    throw new Error("Failed to resolve test server address");
  }

  const wsConnected = new Promise<void>((resolve) => {
    wss.once("connection", (ws) => {
      ws.send(
        JSON.stringify({
          event: "message",
          from_agent_id: "267736442501861376",
          conversation_id: "conv-4001",
          content: "first burst DM",
          sender_type: "agent",
          timestamp: "2026-03-23T08:00:00.000Z"
        })
      );

      setTimeout(() => {
        ws.send(
          JSON.stringify({
            event: "message",
            from_agent_id: "267736442501861376",
            conversation_id: "conv-4001",
            content: "second burst DM",
            sender_type: "agent",
            timestamp: "2026-03-23T08:00:01.000Z"
          })
        );
      }, 800);

      resolve();
    });
  });

  const cfg = {
    channels: {
      clawbond: {
        enabled: true,
        serverUrl: `http://127.0.0.1:${address.port}/ws`,
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
        stateRoot,
        bootstrapEnabled: false,
        runtimeToken: "rt_test",
        agentId: "agent-local",
        agentName: "Anti Spam Test Agent",
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
    getStatus: () => ({ accountId: "default" }),
    setStatus: () => undefined
  });

  if (!runPromise) {
    throw new Error("clawbondPlugin.gateway.startAccount is unavailable");
  }

  try {
    await wsConnected;
    await waitFor(async () => {
      const pending = loadClawBondPendingMainInboxSnapshot(cfg);
      if (!pending || pending.items.length !== 1) {
        return false;
      }

      const merged = pending.items[0]?.content ?? "";
      if (!merged.includes("first burst DM") || !merged.includes("second burst DM")) {
        return false;
      }

      try {
        const wakeLog = await readFile(wakeLogPath, "utf-8");
        const chatSendCount = countOccurrences(wakeLog, "gateway call chat.send --params");
        return chatSendCount === 1;
      } catch {
        return false;
      }
    }, 7000);

    const wakeLog = await readFile(wakeLogPath, "utf-8");
    const chatSendCount = countOccurrences(wakeLog, "gateway call chat.send --params");
    const chatInjectCount = countOccurrences(wakeLog, "gateway call chat.inject --params");

    assert.equal(chatSendCount, 1);
    assert.equal(chatInjectCount, 1);

    const pending = loadClawBondPendingMainInboxSnapshot(cfg);
    assert.ok(pending);
    assert.equal(pending?.items.length, 1);
    assert.match(pending?.items[0]?.content ?? "", /first burst DM/);
    assert.match(pending?.items[0]?.content ?? "", /second burst DM/);

    console.log("dm-anti-spam-burst E2E passed");
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

function countOccurrences(value: string, needle: string): number {
  if (!value || !needle) {
    return 0;
  }

  let count = 0;
  let start = 0;
  while (true) {
    const index = value.indexOf(needle, start);
    if (index < 0) {
      return count;
    }
    count += 1;
    start = index + needle.length;
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

  throw new Error("Timed out waiting for DM anti-spam burst result");
}

await main();
