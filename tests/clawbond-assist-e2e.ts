import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import { ClawBondActivityStore } from "../src/activity-store.ts";
import { createClawBondCommands } from "../src/clawbond-commands.ts";
import {
  buildBackgroundActivityRecap,
  buildConversationStartSummary,
  loadClawBondActivitySnapshot,
  loadClawBondPendingMainInboxSnapshot,
  loadClawBondInboxDigest
} from "../src/clawbond-assist.ts";
import { ClawBondInboxStore } from "../src/inbox-store.ts";
import {
  buildClawBondSetupConfig,
  buildClawBondWelcomeMessage
} from "../src/clawbond-onboarding.ts";
import { createClawBondBeforePromptBuildHandler } from "../src/clawbond-prompt-hooks.ts";
import { enqueueClawBondMainWake } from "../src/main-wake-store.ts";
import { CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE } from "../src/openclaw-cli.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-assist-e2e-"));
  const seenPaths: string[] = [];
  let wsEnabled = true;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seenPaths.push(url.pathname);
    assert.equal(req.headers.authorization, "Bearer agent_jwt_test");

    const send = (status: number, data: unknown, pagination?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: status, data, message: "ok", pagination }));
    };

    if (url.pathname === "/api/agent/notifications/unread-count") {
      send(200, { unread_count: 2 });
      return;
    }

    if (url.pathname === "/api/agent/notifications") {
      send(200, [
        {
          id: "noti-1",
          sender_id: "user-1",
          sender_type: "user",
          content: "请帮我看下今天的一键学习结果",
          is_read: false,
          created_at: "2026-03-19T10:00:00Z"
        },
        {
          id: "noti-2",
          sender_id: "system",
          sender_type: "system",
          content: "你有新的平台提醒",
          is_read: false,
          created_at: "2026-03-19T10:05:00Z"
        }
      ]);
      return;
    }

    if (url.pathname === "/api/agent/messages/poll") {
      assert.equal(url.searchParams.get("limit"), "10");
      send(
        200,
        [
          {
            id: "msg-1",
            conversation_id: "conv-1",
            sender_id: "agent-2",
            sender_name: "Helper Agent",
            content: "我这边整理好了可以对齐的方案",
            created_at: "2026-03-19T09:00:00Z"
          }
        ],
        { next_cursor: "msg-1", has_more: false }
      );
      return;
    }

    if (url.pathname === "/api/agent/connection-requests") {
      send(200, [
        {
          id: "req-1",
          conversation_id: "conv-1",
          requester_id: "agent-2",
          responder_id: "agent-local",
          status: "pending",
          message: "感觉我们主人适合认识一下",
          created_at: "2026-03-19T08:30:00Z"
        },
        {
          id: "req-2",
          conversation_id: "conv-2",
          requester_id: "agent-3",
          responder_id: "agent-local",
          status: "accepted",
          message: "old",
          created_at: "2026-03-18T08:30:00Z"
        }
      ]);
      return;
    }

    if (url.pathname === "/api/agent/capabilities") {
      send(200, {
        ws_enabled: wsEnabled
      });
      return;
    }

    if (url.pathname === "/api/agent/ws" && req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      wsEnabled = body.enabled === true;
      send(200, {
        ws_enabled: wsEnabled
      });
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
        agentName: "Local Agent",
        secretKey: "secret-test",
        bindingStatus: "bound"
      }
    }
  };

  try {
    const activityStore = new ClawBondActivityStore(stateRoot);
    await activityStore.append("default", {
      agentId: "agent-local",
      sessionKey: "channel:clawbond:peer:agent-2",
      peerId: "agent-2",
      peerLabel: "Helper Agent",
      sourceKind: "message",
      event: "background_run_started",
      summary: "Started background handling for DM from Helper Agent"
    });
    await activityStore.append("default", {
      agentId: "agent-local",
      sessionKey: "channel:clawbond:peer:agent-2",
      peerId: "agent-2",
      peerLabel: "Helper Agent",
      sourceKind: "message",
      event: "reply_sent",
      summary: "Replied to Helper Agent",
      preview: "我这边整理好了可以对齐的方案"
    });
    const inboxStore = new ClawBondInboxStore(stateRoot);
    await inboxStore.enqueue("default", {
      fingerprint: "pending:msg-1",
      sourceKind: "message",
      peerId: "agent-2",
      peerLabel: "Helper Agent",
      summary: "Pending DM from Helper Agent",
      content: "请在 main 里处理我这条新消息",
      conversationId: "conv-1",
      receivedAt: "2026-03-19T09:01:00Z"
    });
    await inboxStore.enqueue("default", {
      fingerprint: "pending:msg-2",
      sourceKind: "message",
      peerId: "agent-2",
      peerLabel: "Helper Agent",
      summary: "Pending DM from Helper Agent",
      content: "第二条同会话消息也要一起处理",
      conversationId: "conv-1",
      receivedAt: "2026-03-19T09:02:00Z"
    });
    await inboxStore.enqueue("default", {
      fingerprint: "pending:msg-3",
      sourceKind: "message",
      peerId: "agent-3",
      peerLabel: "Second Agent",
      summary: "Pending DM from Second Agent",
      content: "同一个 conversationId 但不同 peer 不应合并",
      conversationId: "conv-1",
      receivedAt: "2026-03-19T09:03:00Z"
    });
    const primaryPendingItemId = inboxStore
      .listPendingSync("default", 10)
      .find((item) => item.peerId === "agent-2")
      ?.id;
    assert.ok(primaryPendingItemId);
    const pendingItemIds = inboxStore.listPendingSync("default", 10).map((item) => item.id);
    await inboxStore.markWakeRequested("default", pendingItemIds);

    const digest = await loadClawBondInboxDigest(cfg);
    assert.ok(digest, "expected inbox digest");
    assert.equal(digest?.notificationCount, 2);
    assert.equal(digest?.dmCount, 1);
    assert.equal(digest?.pendingConnectionRequestCount, 1);
    assert.equal(digest?.nextDmCursor, "msg-1");

    const summary = buildConversationStartSummary(digest);
    assert.match(summary, /unread notifications: 2/);
    assert.match(summary, /Helper Agent/);
    assert.match(summary, /pending connection requests: 1/);

    const commands = createClawBondCommands({ config: cfg });
    const rootCommand = commands.find((entry) => entry.name === "clawbond");
    assert.ok(rootCommand);
    assert.equal(commands.length, 1);

    const rootHelpResult = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond",
      config: cfg
    } as never);
    assert.match(rootHelpResult?.text ?? "", /ClawBond commands/);
    assert.match(rootHelpResult?.text ?? "", /\/clawbond setup/);
    assert.match(rootHelpResult?.text ?? "", /\/clawbond register/);
    assert.match(rootHelpResult?.text ?? "", /\/clawbond bind/);
    assert.match(rootHelpResult?.text ?? "", /\/clawbond doctor/);
    assert.match(rootHelpResult?.text ?? "", /\/clawbond status/);

    const rootInboxResult = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond inbox",
      args: "inbox",
      config: cfg
    } as never);
    assert.match(rootInboxResult?.text ?? "", /unread notifications: 2/);

    const rootDoctorResult = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond doctor",
      args: "doctor",
      config: cfg
    } as never);
    assert.match(rootDoctorResult?.text ?? "", /ClawBond doctor/);
    assert.match(rootDoctorResult?.text ?? "", /binding: bound/);
    assert.match(rootDoctorResult?.text ?? "", /receive_profile: aggressive/);
    assert.match(rootDoctorResult?.text ?? "", /visible realtime notes: on/);
    assert.match(rootDoctorResult?.text ?? "", /server_ws: true/);

    const directDoctorResult = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond doctor",
      args: "doctor",
      config: cfg
    } as never);
    assert.match(directDoctorResult?.text ?? "", /ClawBond is ready/);

    const emptyCfg = { channels: {} };
    const setupPlan = buildClawBondSetupConfig(emptyCfg, { agentNameArg: "Setup Agent" });
    assert.equal(
      (setupPlan.nextConfig.channels as Record<string, unknown>).clawbond &&
        typeof (setupPlan.nextConfig.channels as Record<string, unknown>).clawbond === "object",
      true
    );
    assert.equal(setupPlan.agentName, "Setup Agent");
    assert.equal(setupPlan.serverUrl, "https://api.clawbond.ai");
    assert.equal(setupPlan.socialBaseUrl, "https://social.clawbond.ai");
    assert.equal(setupPlan.visibleMainSessionNotes, true);

    let writtenConfig: Record<string, unknown> | null = null;
    const setupCommands = createClawBondCommands({
      config: emptyCfg,
      runtime: {
        config: {
          loadConfig: () => emptyCfg,
          writeConfigFile: async (nextCfg) => {
            writtenConfig = nextCfg as Record<string, unknown>;
          }
        }
      } as never
    });
    const setupRootCommand = setupCommands.find((entry) => entry.name === "clawbond");
    assert.ok(setupRootCommand);
    const directSetupResult = await setupRootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond setup Setup Agent",
      args: "setup Setup Agent",
      config: emptyCfg
    } as never);
    assert.match(directSetupResult?.text ?? "", /ClawBond setup saved/);
    assert.ok(writtenConfig);
    const writtenChannel = (writtenConfig?.channels as Record<string, unknown>).clawbond as Record<
      string,
      unknown
    >;
    assert.equal(writtenChannel.enabled, true);
    assert.equal(writtenChannel.agentName, "Setup Agent");
    assert.equal(writtenChannel.serverUrl, "https://api.clawbond.ai");
    assert.equal(writtenChannel.socialBaseUrl, "https://social.clawbond.ai");
    assert.equal(writtenChannel.visibleMainSessionNotes, true);

    const freshWelcome = buildClawBondWelcomeMessage({ channels: {} } as never) ?? "";
    assert.match(freshWelcome, /开始接入 ClawBond/);
    assert.doesNotMatch(freshWelcome, /\/clawbond/);

    const pendingWelcome =
      buildClawBondWelcomeMessage({
        channels: {
          clawbond: {
            enabled: true,
            serverUrl: "https://api.clawbond.ai",
            socialBaseUrl: "https://social.clawbond.ai",
            inviteWebBaseUrl: "https://dev.clawbond.ai/invite",
            stateRoot,
            agentName: "Setup Agent"
          }
        }
      } as never) ?? "";
    assert.match(pendingWelcome, /还没注册 agent/);
    assert.match(pendingWelcome, /先告诉我你想在 ClawBond 上用什么名字/);
    assert.doesNotMatch(pendingWelcome, /\/clawbond/);

    const statusResult = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond status",
      args: "status",
      config: cfg
    } as never);
    assert.match(statusResult?.text ?? "", /binding: bound/);
    assert.match(statusResult?.text ?? "", /visible realtime notes: on/);
    assert.match(statusResult?.text ?? "", /receive_profile: aggressive/);
    assert.doesNotMatch(statusResult?.text ?? "", /dm_delivery_preference \(legacy\):/);
    assert.match(statusResult?.text ?? "", /server_ws: true/);

    const inboxResult = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond inbox",
      args: "inbox",
      config: cfg
    } as never);
    assert.match(inboxResult?.text ?? "", /unread notifications: 2/);
    assert.match(inboxResult?.text ?? "", /pending connection requests: 1/);

    const activityResult = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond activity",
      args: "activity",
      config: cfg
    } as never);
    assert.match(activityResult?.text ?? "", /active legacy background sessions: 1/);
    assert.match(activityResult?.text ?? "", /pending main-session inbox items: 2/);
    assert.match(activityResult?.text ?? "", /Replied to Helper Agent/);

    const activitySnapshot = loadClawBondActivitySnapshot(cfg);
    assert.equal(activitySnapshot?.activeSessions.length, 1);
    assert.equal(activitySnapshot?.recentEntries.at(-1)?.event, "reply_sent");
    assert.match(
      buildBackgroundActivityRecap(activitySnapshot).text,
      /Started background handling for DM from Helper Agent/
    );
    const pendingMainInbox = loadClawBondPendingMainInboxSnapshot(cfg);
    assert.equal(pendingMainInbox?.items.length, 2);
    assert.equal(pendingMainInbox?.items[0]?.conversationId, "conv-1");
    assert.match(pendingMainInbox?.items[0]?.content ?? "", /请在 main 里处理我这条新消息/);
    assert.match(pendingMainInbox?.items[0]?.content ?? "", /第二条同会话消息也要一起处理/);
    assert.equal(pendingMainInbox?.items[1]?.peerId, "agent-3");
    assert.doesNotMatch(
      pendingMainInbox?.items[0]?.content ?? "",
      /同一个 conversationId 但不同 peer 不应合并/
    );

    const hook = createClawBondBeforePromptBuildHandler({
      config: cfg,
      logger: { warn: () => undefined }
    });

    const firstHookResult = await hook(
      { prompt: "hello", messages: [] },
      { sessionId: "session-1", trigger: "user", channelId: "web" }
    );
    assert.match(firstHookResult?.appendSystemContext ?? "", /ClawBond plugin guidance/);
    assert.equal(firstHookResult?.prependContext, undefined);

    const secondHookResult = await hook(
      { prompt: "hello again", messages: [] },
      { sessionId: "session-1", trigger: "user", channelId: "web" }
    );
    assert.equal(secondHookResult?.prependContext, undefined);
    assert.match(secondHookResult?.appendSystemContext ?? "", /ClawBond plugin guidance/);

    await activityStore.append("default", {
      agentId: "agent-local",
      sessionKey: "channel:clawbond:peer:agent-2",
      peerId: "agent-2",
      peerLabel: "Helper Agent",
      sourceKind: "message",
      event: "background_run_completed",
      summary: "Completed background handling for Helper Agent"
    });

    const thirdHookResult = await hook(
      { prompt: "what happened", messages: [] },
      { sessionId: "session-1", trigger: "user", channelId: "web" }
    );
    assert.equal(thirdHookResult?.prependContext, undefined);

    enqueueClawBondMainWake("default", [primaryPendingItemId]);
    const mainHookResult = await hook(
      {
        prompt: "Read HEARTBEAT.md if it exists",
        messages: [`System: [2026-03-21 10:26 UTC] ${CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE}`]
      },
      { sessionId: "agent:main:main", sessionKey: "agent:main:main", trigger: "heartbeat", channelId: "web" }
    );
    assert.match(mainHookResult?.prependSystemContext ?? "", /ClawBond internal realtime payload/);
    assert.match(mainHookResult?.prependSystemContext ?? "", /conversationId: conv-1/);
    assert.match(mainHookResult?.prependSystemContext ?? "", /请在 main 里处理我这条新消息/);
    assert.doesNotMatch(mainHookResult?.prependSystemContext ?? "", /Second Agent/);
    assert.doesNotMatch(mainHookResult?.prependContext ?? "", /ClawBond reminder \/ 消息提醒/);

    const mainUserTurnHookResult = await hook(
      { prompt: "what came in", messages: [] },
      { sessionId: "agent:main:main", sessionKey: "agent:main:main", trigger: "user", channelId: "web" }
    );
    assert.equal(mainUserTurnHookResult?.prependContext, undefined);
    assert.doesNotMatch(mainUserTurnHookResult?.prependSystemContext ?? "", /ClawBond internal realtime payload/);

    enqueueClawBondMainWake("default", [primaryPendingItemId]);
    const mainEscalatedUserTurnHookResult = await hook(
      {
        prompt: `${CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE} DM from Helper Agent`,
        messages: [`${CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE} DM from Helper Agent`]
      },
      { sessionId: "agent:main:main", sessionKey: "agent:main:main", trigger: "user", channelId: "web" }
    );
    assert.match(
      mainEscalatedUserTurnHookResult?.prependSystemContext ?? "",
      /ClawBond internal realtime payload/
    );
    assert.match(
      mainEscalatedUserTurnHookResult?.prependSystemContext ?? "",
      /第二条同会话消息也要一起处理/
    );

    const staleHistoryUserTurnHookResult = await hook(
      {
        prompt: "continue our local chat",
        messages: [
          `System: [2026-03-21 10:26 UTC] ${CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE}`,
          "Assistant: handled the remote wake already"
        ]
      },
      { sessionId: "agent:main:main", sessionKey: "agent:main:main", trigger: "user", channelId: "web" }
    );
    assert.equal(staleHistoryUserTurnHookResult?.prependContext, undefined);
    assert.doesNotMatch(staleHistoryUserTurnHookResult?.prependSystemContext ?? "", /ClawBond internal realtime payload/);

    const channelHookResult = await hook(
      { prompt: "incoming dm", messages: [] },
      { sessionId: "session-2", trigger: "user", channelId: "clawbond" }
    );
    assert.equal(channelHookResult?.prependContext, undefined);

    assert.ok(seenPaths.includes("/api/agent/messages/poll"));
    assert.ok(seenPaths.includes("/api/agent/notifications/unread-count"));
    assert.ok(seenPaths.includes("/api/agent/connection-requests"));
    assert.ok(seenPaths.includes("/api/agent/capabilities"));

    console.log("clawbond-assist E2E passed");
  } finally {
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

await main();
