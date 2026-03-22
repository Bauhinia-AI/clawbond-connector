import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { ClawBondActivityStore } from "../src/activity-store.ts";
import { ClawBondInboxStore } from "../src/inbox-store.ts";
import { createClawBondTools } from "../src/clawbond-tools.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-tools-e2e-"));
  const openclawDir = await mkdtemp(path.join(tmpdir(), "clawbond-tools-openclaw-"));
  const openclawLogPath = path.join(openclawDir, "openclaw.log");
  const fakeOpenClawPath = path.join(openclawDir, "openclaw");
  const originalOpenClawBin = process.env.CLAWBOND_OPENCLAW_BIN;
  process.env.CLAWBOND_OPENCLAW_BIN = fakeOpenClawPath;
  process.env.CLAWBOND_OPENCLAW_LOG = openclawLogPath;

  await writeFile(
    fakeOpenClawPath,
    ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$CLAWBOND_OPENCLAW_LOG"'].join("\n"),
    "utf-8"
  );
  await chmod(fakeOpenClawPath, 0o755);

  const seen: Array<{ method: string; pathname: string; body?: unknown }> = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    let body: unknown = undefined;

    if (method !== "GET") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      if (chunks.length > 0) {
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
    }

    seen.push({ method, pathname, body });

    const send = (status: number, data: unknown, pagination?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: status, data, message: "ok", pagination }));
    };

    if (pathname === "/api/agent/me" && method === "GET") {
      assert.equal(req.headers.authorization, "Bearer agent_jwt_test");
      send(200, { id: "agent-local", name: "Tool Test Agent", user_id: "user-1" });
      return;
    }

    if (pathname === "/api/agent/bind-status" && method === "GET") {
      send(200, { bound: true, user_id: "user-1", username: "test5" });
      return;
    }

    if (pathname === "/api/agent/capabilities" && method === "GET") {
      send(200, { dm: true, learning: true });
      return;
    }

    if (pathname === "/api/feed/agent" && method === "GET") {
      assert.equal(url.searchParams.get("limit"), "5");
      send(200, [{ id: "post-1", title: "Hello feed" }]);
      return;
    }

    if (pathname === "/api/agent-actions/posts" && method === "POST") {
      assert.deepEqual(body, {
        title: "Test post",
        body: "Body",
        agentId: "agent-local"
      });
      send(201, { id: "post-2", title: "Test post" });
      return;
    }

    if (pathname === "/api/agent/messages/send" && method === "POST") {
      assert.deepEqual(body, {
        to_agent_id: "peer-1",
        content: "Hello peer"
      });
      send(201, { conversation_id: "conv-1", message_id: "msg-1" });
      return;
    }

    if (pathname === "/api/conversations/conv-1/messages" && method === "POST") {
      assert.deepEqual(body, {
        content: "Reply in thread"
      });
      send(201, { conversation_id: "conv-1", message_id: "msg-2", to_agent_id: "peer-1" });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 404, data: null, message: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cfg = {
    channels: {
      clawbond: {
        enabled: true,
        serverUrl: baseUrl,
        apiBaseUrl: baseUrl,
        socialBaseUrl: baseUrl,
        stateRoot,
        bootstrapEnabled: false,
        runtimeToken: "agent_jwt_test",
        agentId: "agent-local",
        agentName: "Tool Test Agent",
        secretKey: "secret-test",
        bindingStatus: "bound",
        visibleMainSessionNotes: true
      }
    }
  };

  let runtimeConfig = cfg as Record<string, unknown>;
  setClawBondRuntime({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    config: {
      loadConfig: () => runtimeConfig as never,
      writeConfigFile: async (nextCfg) => {
        runtimeConfig = nextCfg as Record<string, unknown>;
      }
    }
  } as never);

  const tools = createClawBondTools({
    config: cfg,
    senderIsOwner: true,
    agentAccountId: "default",
    sessionKey: "agent:main:main"
  });

  const onboardingTool = requireTool(tools, "clawbond_onboarding");
  const statusTool = requireTool(tools, "clawbond_status");
  const feedTool = requireTool(tools, "clawbond_get_feed");
  const createPostTool = requireTool(tools, "clawbond_create_post");
  const dmTool = requireTool(tools, "clawbond_dm");
  const activityTool = requireTool(tools, "clawbond_activity");

  try {
    const activityStore = new ClawBondActivityStore(stateRoot);
    const inboxStore = new ClawBondInboxStore(stateRoot);
    await activityStore.append("default", {
      agentId: "agent-local",
      sessionKey: "channel:clawbond:peer:peer-1",
      peerId: "peer-1",
      peerLabel: "peer-1",
      sourceKind: "message",
      event: "background_run_started",
      summary: "Started background handling for DM from peer-1"
    });
    await inboxStore.enqueue("default", {
      fingerprint: "pending:peer-1",
      sourceKind: "message",
      peerId: "peer-1",
      peerLabel: "peer-1",
      summary: "Pending DM from peer-1",
      content: "Hello peer",
      conversationId: "conv-1",
      receivedAt: "2026-03-19T09:00:00Z"
    });

    const onboardingSummary = await onboardingTool.execute("tool-0", {
      action: "summary"
    });
    assert.equal(onboardingSummary.details["phase"], "ready");
    assert.equal(onboardingSummary.details["visibleMainSessionNotes"], true);

    const onboardingUpdate = await onboardingTool.execute("tool-0b", {
      action: "update_local_settings",
      notificationsEnabled: false,
      visibleMainSessionNotes: false
    });
    assert.match(
      onboardingUpdate.content[0]?.type === "text" ? onboardingUpdate.content[0].text : "",
      /ClawBond local settings updated/
    );
    const runtimeChannel = (
      runtimeConfig["channels"] as Record<string, unknown>
    )["clawbond"] as Record<string, unknown>;
    assert.equal(runtimeChannel["notificationsEnabled"], false);
    assert.equal(runtimeChannel["visibleMainSessionNotes"], false);

    const statusResult = await statusTool.execute("tool-1", { action: "summary" });
    assert.equal(statusResult.details["profile"]["name"], "Tool Test Agent");
    assert.equal(statusResult.details["bindStatus"]["bound"], true);

    const feedResult = await feedTool.execute("tool-2", { action: "agent", limit: 5 });
    assert.equal(feedResult.details["items"][0]["id"], "post-1");

    const postResult = await createPostTool.execute("tool-3", {
      title: "Test post",
      body: "Body"
    });
    assert.equal(postResult.details["createdPost"]["id"], "post-2");
    assert.match(
      postResult.content[0]?.type === "text" ? postResult.content[0].text : "",
      /Follow-up still needed: reply to peer-1 with `clawbond_dm` using conversationId `conv-1`/
    );

    const dmResult = await dmTool.execute("tool-4", {
      action: "send",
      toAgentId: "peer-1",
      content: "Hello peer"
    });
    assert.equal(dmResult.details["delivery"]["conversation_id"], "conv-1");
    assert.equal(inboxStore.listPendingSync("default").length, 0);
    assert.equal(
      activityStore.listSync("default", 20).some((entry) => entry.event === "pending_handled"),
      true
    );
    await waitFor(async () => {
      try {
        const log = await readFile(openclawLogPath, "utf-8");
        return (
          log.includes("gateway call chat.inject --params") &&
          log.includes("DM reply sent to peer-1. /") &&
          log.includes("label\":\"ClawBond")
        );
      } catch {
        return false;
      }
    }, 3000);

    await inboxStore.enqueue("default", {
      fingerprint: "pending:peer-1:thread",
      sourceKind: "message",
      peerId: "peer-1",
      peerLabel: "peer-1",
      summary: "Pending DM from peer-1",
      content: "Thread hello peer-1",
      conversationId: "conv-1",
      receivedAt: "2026-03-19T09:01:00Z"
    });
    await inboxStore.enqueue("default", {
      fingerprint: "pending:peer-2:thread",
      sourceKind: "message",
      peerId: "peer-2",
      peerLabel: "peer-2",
      summary: "Pending DM from peer-2",
      content: "Thread hello peer-2",
      conversationId: "conv-1",
      receivedAt: "2026-03-19T09:02:00Z"
    });

    const threadedResult = await dmTool.execute("tool-4b", {
      action: "send",
      conversationId: "conv-1",
      content: "Reply in thread"
    });
    assert.equal(threadedResult.details["delivery"]["conversation_id"], "conv-1");
    assert.deepEqual(
      inboxStore.listPendingSync("default").map((item) => item.peerId),
      ["peer-2"]
    );

    const activityResult = await activityTool.execute("tool-5", { action: "active" });
    assert.equal(activityResult.details["activeSessions"][0]["peerId"], "peer-1");

    assert.ok(seen.some((entry) => entry.pathname === "/api/agent/me"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/feed/agent"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/agent-actions/posts"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/agent/messages/send"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/conversations/conv-1/messages"));

    console.log("clawbond-tools E2E passed");
  } finally {
    delete process.env.CLAWBOND_OPENCLAW_LOG;
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
    await rm(openclawDir, { recursive: true, force: true });
  }
}

function requireTool(
  tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }>,
  name: string
) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Missing tool ${name}`);
  }

  return tool;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for OpenClaw UI inject");
}

await main();
