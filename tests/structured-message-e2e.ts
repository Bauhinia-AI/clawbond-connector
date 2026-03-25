import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { clawbondPlugin } from "../src/channel.ts";
import { loadClawBondPendingMainInboxSnapshot } from "../src/clawbond-assist.ts";
import { resolveAccount } from "../src/config.ts";
import { DEFAULT_STRUCTURED_MESSAGE_PREFIX } from "../src/message-envelope.ts";
import { createClawBondBeforePromptBuildHandler } from "../src/clawbond-prompt-hooks.ts";
import { CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE } from "../src/openclaw-cli.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-structured-message-e2e-"));
  const openclawDir = await mkdtemp(path.join(tmpdir(), "clawbond-structured-message-openclaw-"));
  const fakeOpenClawPath = path.join(openclawDir, "openclaw");
  const originalOpenClawBin = process.env.CLAWBOND_OPENCLAW_BIN;
  process.env.CLAWBOND_OPENCLAW_BIN = fakeOpenClawPath;
  await writeFile(fakeOpenClawPath, ['#!/bin/sh', "exit 0"].join("\n"), "utf-8");
  await chmod(fakeOpenClawPath, 0o755);

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    const send = (status: number, data: unknown, pagination?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: status, data, message: "ok", pagination }));
    };

    if (url.pathname === "/api/agent/messages/poll") {
      send(200, [], { next_cursor: null });
      return;
    }

    if (url.pathname === "/api/agent/bind-status") {
      send(200, { bound: true, user_id: "user-1", username: "owner" });
      return;
    }

    if (url.pathname === "/api/agent/me") {
      send(200, { id: "agent-local", name: "Local Agent", user_id: "user-1" });
      return;
    }

    send(404, null);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    assert.equal(url.searchParams.get("token"), "rt_test");
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

  const trustedContent =
    `${DEFAULT_STRUCTURED_MESSAGE_PREFIX}\n` +
    JSON.stringify({
      type: "learn.push",
      taskId: "learn_001",
      title: "One-click learning",
      body: "Read the suggested post and draft a concise learning note.",
      payload: {
        postId: "post_123",
        source: "rec_sys"
      }
    });
  const untrustedContent =
    `${DEFAULT_STRUCTURED_MESSAGE_PREFIX}\n` +
    JSON.stringify({
      type: "learn.push",
      taskId: "learn_999",
      body: "This should stay plain because the sender is not trusted."
    });

  const connected = new Promise<void>((resolve) => {
    wss.once("connection", (ws) => {
      ws.send(
        JSON.stringify({
          event: "message",
          from_agent_id: "agent-rec-sys",
          content: trustedContent,
          timestamp: "2026-03-18T09:00:00.000Z"
        })
      );
      ws.send(
        JSON.stringify({
          event: "message",
          from_agent_id: "agent-untrusted",
          content: untrustedContent,
          timestamp: "2026-03-18T09:00:01.000Z"
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
        bindingStatus: "bound",
        notificationsEnabled: false,
        visibleMainSessionNotes: false,
        bindStatusPollIntervalMs: 60_000,
        trustedSenderAgentIds: ["agent-rec-sys"]
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
  } as never);

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
    channelRuntime: {} as never,
    getStatus: () => ({ accountId: "default" }),
    setStatus: () => undefined
  });

  if (!runPromise) {
    throw new Error("clawbondPlugin.gateway.startAccount is unavailable");
  }

  try {
    await connected;
    await waitFor(() => {
      const snapshot = loadClawBondPendingMainInboxSnapshot(cfg, "default", 10);
      return snapshot?.items.length === 2;
    }, 5000);

    const snapshot = loadClawBondPendingMainInboxSnapshot(cfg, "default", 10);
    assert.ok(snapshot, "expected pending main inbox snapshot");
    assert.equal(snapshot?.items.length, 2);

    const trustedItem = snapshot?.items.find((item) => item.peerId === "agent-rec-sys");
    const untrustedItem = snapshot?.items.find((item) => item.peerId === "agent-untrusted");

    assert.ok(trustedItem, "expected trusted pending item");
    assert.ok(untrustedItem, "expected untrusted pending item");
    assert.match(trustedItem?.content ?? "", /ClawBond platform event/);
    assert.match(trustedItem?.content ?? "", /Type: learn\.push/);
    assert.match(trustedItem?.content ?? "", /Task ID: learn_001/);
    assert.match(trustedItem?.content ?? "", /Payload JSON:/);
    assert.equal(untrustedItem?.content, untrustedContent);

    await new Promise((resolve) => setTimeout(resolve, 700));

    const hook = createClawBondBeforePromptBuildHandler({
      config: cfg,
      logger: { warn: () => undefined }
    });

    const hookResult = await hook(
      {
        prompt: CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE,
        messages: [{ text: CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE }]
      } as never,
      {
        sessionId: "session-main",
        sessionKey: "agent:main:main",
        channelId: "web",
        trigger: "system"
      } as never
    );

    const injected = hookResult?.prependSystemContext ?? "";
    assert.match(injected, /ClawBond internal realtime payload/);
    assert.match(injected, /ClawBond platform event/);
    assert.match(injected, /Type: learn\.push/);
    assert.match(injected, /\[CLAWBOND_EVENT\]/);
    assert.match(injected, /This should stay plain because the sender is not trusted\./);

    console.log("structured-message E2E passed");
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
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    if (originalOpenClawBin === undefined) {
      delete process.env.CLAWBOND_OPENCLAW_BIN;
    } else {
      process.env.CLAWBOND_OPENCLAW_BIN = originalOpenClawBin;
    }
    await rm(openclawDir, { recursive: true, force: true });
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
        reject(new Error("Timed out waiting for structured messages to reach the pending inbox"));
        return;
      }

      setTimeout(tick, 25);
    };

    tick();
  });
}

await main();
