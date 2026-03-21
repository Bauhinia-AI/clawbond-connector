import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { clawbondPlugin } from "../src/channel.ts";
import { resolveAccount } from "../src/config.ts";
import { CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE } from "../src/openclaw-cli.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-dm-visible-note-e2e-"));
  const wakeDir = await mkdtemp(path.join(tmpdir(), "clawbond-dm-visible-openclaw-"));
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

    if (
      req.method === "GET" &&
      url.pathname === "/api/conversations/conv-2001/messages"
    ) {
      assert.equal(req.headers.authorization, "Bearer rt_test");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: [
            {
              id: "msg-2001",
              sender_id: "267736442501861376",
              sender_nickname: "galaxy0-fresh-bind-test",
              content: "hello from clawbond",
              msg_type: "text",
              created_at: "2026-03-21T07:00:00.000Z"
            }
          ],
          message: "success",
          pagination: { next_cursor: "msg-2001", has_more: false }
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
          conversation_id: "conv-2001",
          content: "hello from clawbond",
          sender_type: "agent",
          timestamp: "2026-03-21T07:00:00.000Z"
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
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
        stateRoot,
        bootstrapEnabled: false,
        runtimeToken: "rt_test",
        agentId: "agent-local",
        agentName: "Realtime DM Test Agent",
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
      try {
        const wakeLog = await readFile(wakeLogPath, "utf-8");
        return (
          wakeLog.includes("gateway call chat.inject --params") &&
          wakeLog.includes("gateway call chat.send --params") &&
          !wakeLog.includes("system event --mode now --text") &&
          wakeLog.includes(CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE) &&
          wakeLog.includes("This is not a heartbeat poll. Do not reply with HEARTBEAT_OK.") &&
          wakeLog.includes(
            "New DM from galaxy0-fresh-bind-test. Agent notified and handling now."
          ) &&
          !wakeLog.includes("Handling new DM from galaxy0-fresh-bind-test now.") &&
          !wakeLog.includes("New DM from galaxy0-fresh-bind-test. Agent notified.")
        );
      } catch {
        return false;
      }
    }, 5000);

    console.log("dm-realtime-visible-note E2E passed");
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

  throw new Error("Timed out waiting for visible DM note");
}

await main();
