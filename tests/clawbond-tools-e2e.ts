import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { ClawBondActivityStore } from "../src/activity-store.ts";
import { CredentialStore } from "../src/credential-store.ts";
import { ClawBondInboxStore } from "../src/inbox-store.ts";
import { createClawBondTools } from "../src/clawbond-tools.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-tools-e2e-"));
  const registerStateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-register-tools-e2e-"));
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
  const registerState = {
    accessToken: "agent_jwt_register",
    refreshedToken: "agent_jwt_register_refreshed",
    agentId: "agent-register",
    agentName: "Fresh Agent",
    secretKey: "secret-register",
    bindCode: "BIND-REGISTER",
    bound: false
  };

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
      const auth = req.headers.authorization;
      if (auth === "Bearer agent_jwt_test") {
        send(200, { id: "agent-local", name: "Tool Test Agent", user_id: "user-1" });
        return;
      }

      if (
        auth === `Bearer ${registerState.accessToken}` ||
        auth === `Bearer ${registerState.refreshedToken}`
      ) {
        send(200, {
          id: registerState.agentId,
          name: registerState.agentName,
          user_id: registerState.bound ? "user-register" : null,
          bind_code: registerState.bound ? "BIND-BOUND" : registerState.bindCode
        });
        return;
      }

      assert.fail(`Unexpected auth header for /api/agent/me: ${String(auth)}`);
      return;
    }

    if (pathname === "/api/agent/bind-status" && method === "GET") {
      const auth = req.headers.authorization;
      if (auth === "Bearer agent_jwt_test") {
        send(200, { bound: true, user_id: "user-1", username: "test5" });
        return;
      }

      if (
        auth === `Bearer ${registerState.accessToken}` ||
        auth === `Bearer ${registerState.refreshedToken}`
      ) {
        send(
          200,
          registerState.bound
            ? { bound: true, user_id: "user-register", username: "fresh-user" }
            : { bound: false }
        );
        return;
      }

      assert.fail(`Unexpected auth header for /api/agent/bind-status: ${String(auth)}`);
      return;
    }

    if (pathname === "/api/agent/capabilities" && method === "GET") {
      send(200, {
        can_dm: true,
        can_learn: true,
        can_propose_connection: true
      });
      return;
    }

    if (pathname === "/api/agent/me" && method === "PUT") {
      assert.equal(req.headers.authorization, "Bearer agent_jwt_test");
      send(200, { id: "agent-local", name: (body as Record<string, unknown>).name ?? "Tool Test Agent" });
      return;
    }

    if (pathname === "/api/agent/capabilities" && method === "PUT") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 403, data: null, message: "forbidden" }));
      return;
    }

    if (pathname === "/api/conversations" && method === "GET") {
      assert.equal(url.searchParams.get("page"), "2");
      assert.equal(url.searchParams.get("limit"), "5");
      assert.equal(url.searchParams.get("category"), "participated");
      send(
        200,
        [{ id: "conv-1", name: "Peer thread" }],
        { page: 2, page_size: 5, total: 1, total_pages: 1 }
      );
      return;
    }

    if (pathname === "/api/conversations/conv-1/messages" && method === "GET") {
      assert.equal(url.searchParams.get("before"), "msg-prev");
      assert.equal(url.searchParams.get("limit"), "5");
      send(
        200,
        [{ id: "msg-old", sender_id: "peer-1", content: "Older message" }],
        { has_more: false, next_cursor: null }
      );
      return;
    }

    if (pathname === "/api/auth/agent/register" && method === "POST") {
      assert.deepEqual(body, { name: "Fresh Agent" });
      send(200, {
        access_token: registerState.accessToken,
        agent_id: registerState.agentId,
        secret_key: registerState.secretKey,
        bind_code: registerState.bindCode
      });
      return;
    }

    if (pathname === "/api/auth/agent/refresh" && method === "POST") {
      assert.deepEqual(body, {
        agent_id: registerState.agentId,
        secret_key: registerState.secretKey
      });
      send(200, { access_token: registerState.refreshedToken });
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

    if (pathname === "/api/agent-actions/comments" && method === "POST") {
      const payload = body as Record<string, unknown>;
      assert.equal(payload.postId, "post-2");
      assert.equal(payload.agentId, "agent-local");
      assert.equal(typeof payload.body, "string");
      send(201, { id: "comment-1", postId: "post-2" });
      return;
    }

    if (pathname === "/api/agent-actions/comments/reply" && method === "POST") {
      assert.deepEqual(body, {
        postId: "post-2",
        commentId: "comment-root-1",
        body: "Reply on thread",
        agentId: "agent-local"
      });
      send(201, { id: "comment-reply-1", postId: "post-2", parentCommentId: "comment-root-1" });
      return;
    }

    if (pathname === "/api/agent-actions/comments/unread" && method === "GET") {
      send(200, [{ postId: "post-2", unreadCount: 2 }]);
      return;
    }

    if (pathname === "/api/agent-actions/posts/post-2/comments/unread" && method === "GET") {
      assert.equal(url.searchParams.get("limit"), "2");
      send(200, [{ id: "comment-root-1", postId: "post-2", body: "Need follow-up" }]);
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

    if (pathname === "/api/agent/messages/send-to-owner" && method === "POST") {
      assert.deepEqual(body, {
        content: "Owner follow-up",
        msg_type: "text"
      });
      send(201, { conversation_id: "conv-owner-1", message_id: "msg-owner-1" });
      return;
    }

    if (pathname === "/api/conversations/conv-1/messages" && method === "POST") {
      assert.deepEqual(body, {
        content: "Reply in thread",
        msg_type: "text",
        reply_to_id: "msg-prev"
      });
      send(201, { conversation_id: "conv-1", message_id: "msg-2", to_agent_id: "peer-1" });
      return;
    }

    if (pathname === "/api/agent/learning/reports" && method === "GET") {
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("limit"), "3");
      send(200, [{ id: "report-1", title: "Memory consolidation" }], { page: 1, page_size: 3, total: 1 });
      return;
    }

    if (pathname === "/api/agent/learning/feedback" && method === "GET") {
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("limit"), "3");
      send(
        200,
        [{ id: "feedback-1", report_id: "report-1", feedback: "useful" }],
        { page: 1, page_size: 3, total: 1 }
      );
      return;
    }

    if (pathname === "/api/agent/learning/reports" && method === "POST") {
      assert.deepEqual(body, {
        title: "Learning note",
        content: "Detailed content",
        summary: "Short summary",
        category: "knowledge_memory"
      });
      send(201, { id: "report-1", title: "Learning note" });
      return;
    }

    if (pathname === "/api/agent/learning/reports/report-1/feedback" && method === "GET") {
      send(200, { score: 92, note: "Looks good" });
      return;
    }

    if (pathname === "/api/agent/learning/reports/report-1" && method === "PUT") {
      assert.deepEqual(body, {
        summary: "Updated summary"
      });
      send(200, { id: "report-1", summary: "Updated summary" });
      return;
    }

    if (pathname === "/api/agent/learning/reports/report-1" && method === "DELETE") {
      send(200, { deleted: true });
      return;
    }

    if (pathname === "/api/agent/connection-requests" && method === "GET") {
      assert.equal(url.searchParams.get("conversation_id"), "conv-1");
      assert.equal(url.searchParams.get("status"), "pending");
      send(200, [{ id: "req-1", conversation_id: "conv-1", status: "pending" }]);
      return;
    }

    if (pathname === "/api/agent/notifications/send" && method === "POST") {
      assert.deepEqual(body, {
        content: "Start learning now",
        type: "learn"
      });
      send(201, { id: "noti-1", content: "Start learning now", noti_type: "learn" });
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

  const registerTool = requireTool(tools, "clawbond_register");
  const statusTool = requireTool(tools, "clawbond_status");
  const dmTool = requireTool(tools, "clawbond_dm");
  const notificationsTool = requireTool(tools, "clawbond_notifications");
  const connectionRequestsTool = requireTool(tools, "clawbond_connection_requests");
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

    const registerSummary = await registerTool.execute("tool-0", {
      action: "summary"
    });
    assert.equal(registerSummary.details["phase"], "ready");
    assert.equal(registerSummary.details["visibleMainSessionNotes"], true);
    assert.equal(registerSummary.details["receiveProfile"], "aggressive");

    const onboardingUpdate = await registerTool.execute("tool-0b", {
      action: "local_settings",
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
    const postUpdateSettings = new CredentialStore(stateRoot).loadUserSettingsSync("default");
    assert.equal(postUpdateSettings.receive_profile, "aggressive");

    const statusResult = await statusTool.execute("tool-1", { action: "summary" });
    assert.equal(statusResult.details["profile"]["name"], "Tool Test Agent");
    assert.equal(statusResult.details["bindStatus"]["bound"], true);

    const conversationListResult = await dmTool.execute("tool-3g", {
      action: "list_conversations",
      page: 2,
      limit: 5,
      category: "participated"
    });
    assert.equal(conversationListResult.details["conversations"][0]["id"], "conv-1");
    assert.equal(conversationListResult.details["pagination"]["page"], 2);

    const messageListResult = await dmTool.execute("tool-3h", {
      action: "list_messages",
      conversationId: "conv-1",
      before: "msg-prev",
      limit: 5
    });
    assert.equal(messageListResult.details["messages"][0]["id"], "msg-old");

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
      content: "Reply in thread",
      msgType: "text",
      replyToId: "msg-prev"
    });
    assert.equal(threadedResult.details["delivery"]["conversation_id"], "conv-1");
    assert.deepEqual(
      inboxStore.listPendingSync("default").map((item) => item.peerId),
      ["peer-2"]
    );

    const ownerDmResult = await dmTool.execute("tool-4b-owner", {
      action: "send_to_owner",
      content: "Owner follow-up",
      msgType: "text"
    });
    assert.equal(ownerDmResult.details["delivery"]["conversation_id"], "conv-owner-1");

    const notificationSendResult = await notificationsTool.execute("tool-4h", {
      action: "send",
      content: "Start learning now",
      type: "learn"
    });
    assert.equal(notificationSendResult.details["sent"]["noti_type"], "learn");

    const requestListResult = await connectionRequestsTool.execute("tool-4i", {
      action: "list",
      conversationId: "conv-1",
      status: "pending"
    });
    assert.equal(requestListResult.details["requests"][0]["id"], "req-1");

    const activityResult = await activityTool.execute("tool-5", { action: "active" });
    assert.equal(activityResult.details["activeSessions"][0]["peerId"], "peer-1");

    let registerRuntimeConfig = {
      channels: {
        clawbond: {
          enabled: true,
          serverUrl: baseUrl,
          apiBaseUrl: baseUrl,
          socialBaseUrl: baseUrl,
          stateRoot: registerStateRoot
        }
      }
    } as Record<string, unknown>;

    setClawBondRuntime({
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      config: {
        loadConfig: () => registerRuntimeConfig as never,
        writeConfigFile: async (nextCfg) => {
          registerRuntimeConfig = nextCfg as Record<string, unknown>;
        }
      }
    } as never);

    const registerOnlyTools = createClawBondTools({
      config: registerRuntimeConfig as never,
      senderIsOwner: true,
      agentAccountId: "default",
      sessionKey: "agent:main:main"
    });
    const explicitRegisterTool = requireTool(registerOnlyTools, "clawbond_register");

    const preCreateSummary = await explicitRegisterTool.execute("tool-6", {
      action: "summary"
    });
    assert.equal(preCreateSummary.details["phase"], "registration_required");

    const registerCreate = await explicitRegisterTool.execute("tool-7", {
      action: "create",
      agentName: "Fresh Agent"
    });
    assert.match(
      registerCreate.content[0]?.type === "text" ? registerCreate.content[0].text : "",
      /ClawBond agent registered/
    );
    assert.equal(registerCreate.details["phase"], "waiting_for_bind");

    const stored = new CredentialStore(registerStateRoot).loadSync("default");
    assert.equal(stored?.credentials.agent_id, registerState.agentId);
    assert.equal(stored?.credentials.binding_status, "pending");

    registerState.bound = true;
    const bindResult = await explicitRegisterTool.execute("tool-8", {
      action: "bind"
    });
    assert.match(
      bindResult.content[0]?.type === "text" ? bindResult.content[0].text : "",
      /ClawBond binding is complete/
    );
    assert.equal(bindResult.details["phase"], "ready");
    assert.equal(bindResult.details["bindingStatus"], "bound");

    const nonOwnerTools = createClawBondTools({
      config: cfg,
      senderIsOwner: false,
      requesterSenderId: "user-non-owner",
      messageChannel: "clawbond",
      agentAccountId: "default",
      sessionKey: "agent:main:main"
    });
    const nonOwnerRegisterTool = requireTool(nonOwnerTools, "clawbond_register");
    const nonOwnerDmTool = requireTool(nonOwnerTools, "clawbond_dm");
    const nonOwnerActivityTool = requireTool(nonOwnerTools, "clawbond_activity");

    const nonOwnerSummary = await nonOwnerRegisterTool.execute("tool-9", {
      action: "summary"
    });
    assert.equal(nonOwnerSummary.details["phase"], "ready");

    const nonOwnerSettingsUpdate = await nonOwnerRegisterTool.execute("tool-10", {
      action: "local_settings",
      notificationsEnabled: true
    });
    assert.match(
      nonOwnerSettingsUpdate.content[0]?.type === "text" ? nonOwnerSettingsUpdate.content[0].text : "",
      /ClawBond local settings updated/
    );

    const nonOwnerDmList = await nonOwnerDmTool.execute("tool-11", {
      action: "list_conversations",
      page: 2,
      limit: 5,
      category: "participated"
    });
    assert.equal(nonOwnerDmList.details["conversations"][0]["id"], "conv-1");

    const nonOwnerActivity = await nonOwnerActivityTool.execute("tool-12", {
      action: "summary"
    });
    assert.equal(nonOwnerActivity.details["accountId"], "default");

    const remoteOwnerTools = createClawBondTools({
      config: cfg,
      senderIsOwner: false,
      requesterSenderId: "user-1",
      messageChannel: "clawbond",
      agentAccountId: "default",
      sessionKey: "agent:main:main"
    });
    const remoteOwnerRegisterTool = requireTool(remoteOwnerTools, "clawbond_register");
    const remoteOwnerActivityTool = requireTool(remoteOwnerTools, "clawbond_activity");

    const remoteOwnerSummary = await remoteOwnerRegisterTool.execute("tool-13", {
      action: "summary"
    });
    assert.equal(remoteOwnerSummary.details["phase"], "ready");

    const remoteOwnerActivity = await remoteOwnerActivityTool.execute("tool-14", {
      action: "summary"
    });
    assert.equal(remoteOwnerActivity.details["accountId"], "default");

    assert.ok(seen.some((entry) => entry.pathname === "/api/agent/me"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/agent/messages/send"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/agent/messages/send-to-owner"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/conversations"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/conversations/conv-1/messages"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/agent/notifications/send"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/agent/connection-requests"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/auth/agent/register"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/auth/agent/refresh"));

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
    await rm(registerStateRoot, { recursive: true, force: true });
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
