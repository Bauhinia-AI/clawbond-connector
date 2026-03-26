import type {
  AnyAgentTool,
  OpenClawPluginToolContext
} from "openclaw/plugin-sdk/compat";

import { ClawBondActivityStore } from "./activity-store.ts";
import { ClawBondToolSession } from "./clawbond-api.ts";
import { loadClawBondActivitySnapshot } from "./clawbond-assist.ts";
import { ClawBondInboxStore } from "./inbox-store.ts";
import {
  buildClawBondOnboardingSummary,
  runClawBondRegisterBind,
  runClawBondRegisterCreate,
  runClawBondLocalConfigUpdate,
  runClawBondSetup
} from "./clawbond-onboarding.ts";
import { queueMainSessionVisibleNote } from "./openclaw-cli.ts";
import { getClawBondRuntime } from "./runtime.ts";
import type {
  ClawBondPendingInboxItem
} from "./types.ts";
import {
  ToolInputError,
  clampLimit,
  ensureToolAccess,
  ensureOwnerOnlyToolAccess,
  jsonToolResult,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readRequiredString,
  textToolResult
} from "./tooling.ts";

const accountIdProperty = {
  type: "string",
  description: "Optional ClawBond accountId. Defaults to the active/default account."
} as const;

const limitProperty = {
  type: "number",
  description: "Optional limit. Defaults to a sensible value and is capped at 100."
} as const;

export function createClawBondTools(ctx: OpenClawPluginToolContext): AnyAgentTool[] {
  return [
    createRegisterTool(ctx),
    createStatusTool(ctx),
    createDmTool(ctx),
    createActivityTool(ctx),
    createNotificationsTool(ctx),
    createConnectionRequestsTool(ctx)
  ];
}

function createRegisterTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_register",
    label: "ClawBond Register",
    description:
      "Guide explicit ClawBond setup, registration, binding, and local plugin toggles in natural language without forcing the human to memorize slash commands first.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description:
            "summary | setup | create | bind | local_settings"
        },
        accountId: accountIdProperty,
        agentName: {
          type: "string",
          description: "Optional display name to use during initial setup or local rename."
        },
        notificationsEnabled: {
          type: "boolean",
          description: "Toggle realtime notification polling for ClawBond."
        },
        visibleMainSessionNotes: {
          type: "boolean",
          description: "Toggle visible [ClawBond] notes in the main OpenClaw chat."
        }
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const action = readRequiredString(rawParams, "action");
      const runtime = getClawBondRuntime();
      const accountId = readOptionalString(rawParams, "accountId") ?? ctx.agentAccountId;

      switch (action) {
        case "summary": {
          ensureToolAccess(ctx, "clawbond_register", "read", accountId);
          const summary = buildClawBondOnboardingSummary(ctx.config, accountId);
          const lines = [
            `ClawBond register summary (${summary.accountId})`,
            `- phase: ${summary.phase}`,
            `- configured: ${summary.configured ? "yes" : "no"}`,
            `- local credentials: ${summary.localCredentialsFound ? "found" : "missing"}`,
            `- binding: ${summary.bindingStatus}`,
            `- notifications: ${summary.notificationsEnabled ? "enabled" : "disabled"}`,
            `- visible realtime notes: ${summary.visibleMainSessionNotes ? "on" : "off"}`,
            `- receive profile: ${summary.receiveProfile} (fixed local default)`,
            `- next: ${summary.nextStep}`
          ];
          if (summary.inviteUrl) {
            lines.push(`- invite: ${summary.inviteUrl}`);
          }
          lines.push(
            "",
            `Natural prompts you can accept from the human: ${summary.suggestedUserPhrases.join(" / ")}`
          );
          lines.push(
            `Manual fallback: ${summary.manualFallbackCommands.join(" / ")}`
          );
          return textToolResult(lines.join("\n"), summary);
        }
        case "setup": {
          ensureOwnerOnlyToolAccess(ctx, "clawbond_register.setup", "write", accountId);
          const text = await runClawBondSetup({
            cfg: ctx.config,
            runtime,
            agentNameArg: readOptionalString(rawParams, "agentName") ?? null
          });
          const summary = buildClawBondOnboardingSummary(
            runtime.config?.loadConfig?.() ?? ctx.config,
            accountId
          );
          return textToolResult(text, summary);
        }
        case "create": {
          ensureOwnerOnlyToolAccess(ctx, "clawbond_register.create", "write", accountId);
          const text = await runClawBondRegisterCreate({
            cfg: ctx.config,
            runtime,
            accountId,
            agentNameArg: readOptionalString(rawParams, "agentName") ?? null
          });
          const summary = buildClawBondOnboardingSummary(
            runtime.config?.loadConfig?.() ?? ctx.config,
            accountId
          );
          return textToolResult(text, summary);
        }
        case "bind": {
          ensureOwnerOnlyToolAccess(ctx, "clawbond_register.bind", "write", accountId);
          const text = await runClawBondRegisterBind({
            cfg: ctx.config,
            runtime,
            accountId
          });
          const summary = buildClawBondOnboardingSummary(
            runtime.config?.loadConfig?.() ?? ctx.config,
            accountId
          );
          return textToolResult(text, summary);
        }
        case "local_settings": {
          ensureOwnerOnlyToolAccess(ctx, "clawbond_register.local_settings", "write", accountId);
          const text = await runClawBondLocalConfigUpdate({
            cfg: ctx.config,
            runtime,
            accountId,
            notificationsEnabled: readOptionalBoolean(rawParams, "notificationsEnabled"),
            visibleMainSessionNotes: readOptionalBoolean(rawParams, "visibleMainSessionNotes")
          });
          const summary = buildClawBondOnboardingSummary(
            runtime.config?.loadConfig?.() ?? ctx.config,
            accountId
          );
          return textToolResult(text, summary);
        }
        default:
          throw new ToolInputError(`Unsupported clawbond_register action: ${action}`);
      }
    }
  };
}

function createStatusTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_status",
    label: "ClawBond Status",
    description:
      "Read ClawBond agent identity, binding, and communication capabilities without mutating human-side settings.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "summary | me | bind_status | capabilities"
        },
        accountId: accountIdProperty
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const accountId = readOptionalString(rawParams, "accountId") ?? ctx.agentAccountId;
      ensureToolAccess(ctx, "clawbond_status", "read", accountId);
      const action = readRequiredString(rawParams, "action");
      const session = new ClawBondToolSession(ctx.config, accountId);

      const details = await session.withAgentToken(`clawbond_status:${action}`, async (token) => {
        switch (action) {
          case "summary": {
            const [profile, bindStatus, capabilities] = await Promise.all([
              session.server.getMe(token, signal),
              session.server.getBindStatus(token, signal),
              session.server.getCapabilities(token, signal)
            ]);
            return {
              account: summarizeAccount(session),
              profile: profile.data,
              bindStatus: bindStatus.data,
              capabilities: capabilities.data
            };
          }
          case "me":
            return {
              account: summarizeAccount(session),
              profile: (await session.server.getMe(token, signal)).data
            };
          case "bind_status":
            return {
              account: summarizeAccount(session),
              bindStatus: (await session.server.getBindStatus(token, signal)).data
            };
          case "capabilities":
            return {
              account: summarizeAccount(session),
              capabilities: (await session.server.getCapabilities(token, signal)).data
            };
          default:
            throw new ToolInputError(`Unsupported clawbond_status action: ${action}`);
        }
      });

      return jsonToolResult(`ClawBond status action ${action} completed.`, details);
    }
  };
}

function createDmTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_dm",
    label: "ClawBond DM",
    description:
      "List conversations, read messages, poll new messages, or send a ClawBond DM.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "list_conversations | list_messages | poll | send | send_to_owner"
        },
        accountId: accountIdProperty,
        page: {
          type: "number",
          description: "Optional page number for action=list_conversations"
        },
        category: {
          type: "string",
          description: "Optional conversation category for action=list_conversations: proxy | recommended | participated"
        },
        conversationId: {
          type: "string",
          description: "Required for list_messages or send to an existing conversation"
        },
        toAgentId: {
          type: "string",
          description: "Required for send when conversationId is not provided"
        },
        content: {
          type: "string",
          description: "Required for action=send"
        },
        after: {
          type: "string",
          description: "Optional cursor for action=poll"
        },
        before: {
          type: "string",
          description: "Optional message cursor for action=list_messages"
        },
        msgType: {
          type: "string",
          description: "Optional outbound message type for action=send"
        },
        replyToId: {
          type: "string",
          description: "Optional reply target for action=send when conversationId is provided"
        },
        limit: limitProperty
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const accountId = readOptionalString(rawParams, "accountId") ?? ctx.agentAccountId;
      ensureToolAccess(ctx, "clawbond_dm", "write", accountId);
      const action = readRequiredString(rawParams, "action");
      const session = new ClawBondToolSession(ctx.config, accountId);
      const limit = clampLimit(readOptionalNumber(rawParams, "limit"), 20);
      const page = clampLimit(readOptionalNumber(rawParams, "page"), 1, 10000);

      const details = await session.withAgentToken(`clawbond_dm:${action}`, async (token) => {
        switch (action) {
          case "list_conversations": {
            const result = await session.server.listConversations(
              token,
              {
                page,
                limit,
                category: readOptionalString(rawParams, "category") as
                  | "proxy"
                  | "recommended"
                  | "participated"
                  | undefined
              },
              signal
            );
            return {
              account: summarizeAccount(session),
              conversations: result.data,
              pagination: result.pagination
            };
          }
          case "list_messages": {
            const result = await session.server.listConversationMessages(
              token,
              readRequiredString(rawParams, "conversationId"),
              {
                before: readOptionalString(rawParams, "before"),
                limit
              },
              signal
            );
            return {
              account: summarizeAccount(session),
              messages: result.data,
              pagination: result.pagination
            };
          }
          case "poll": {
            const result = await session.server.pollMessages(
              token,
              readOptionalString(rawParams, "after"),
              limit,
              signal
            );
            return {
              account: summarizeAccount(session),
              messages: result.data,
              pagination: result.pagination
            };
          }
          case "send": {
            const conversationId = readOptionalString(rawParams, "conversationId");
            const content = readRequiredString(rawParams, "content");
            const msgType = readOptionalString(rawParams, "msgType") ?? undefined;
            const inboxStore = new ClawBondInboxStore(session.account.stateRoot);
            if (conversationId) {
              const delivery = (
                await session.server.sendConversationMessage(
                  token,
                  conversationId,
                  content,
                  {
                    msgType,
                    replyToId: readOptionalString(rawParams, "replyToId") ?? undefined
                  },
                  signal
                )
              ).data;
              const deliveryPeerId =
                readStringField(delivery, "to_agent_id") || readStringField(delivery, "toAgentId");
              const handled = await inboxStore.markLatestPendingByConversation(
                session.account.accountId,
                conversationId,
                content,
                "clawbond_dm",
                deliveryPeerId || undefined
              );
              await appendToolActivity(ctx, session, {
                event: "reply_sent",
                sourceKind: "message",
                conversationId,
                peerId: deliveryPeerId,
                summary: `Replied from main session in conversation ${conversationId}`,
                preview: content
              });
              injectVisibleMainSessionNote(session,
                `DM reply sent. / 已发送私信回复。`
              );
              await appendHandledInboxActivity(ctx, session, handled);
              return {
                account: summarizeAccount(session),
                delivery
              };
            }

            const toAgentId = readRequiredString(rawParams, "toAgentId");
            const delivery = (
              await session.server.sendFirstMessage(token, toAgentId, content, msgType, signal)
            ).data;
            const handled = await inboxStore.markHandledByPeer(
              session.account.accountId,
              toAgentId,
              content
            );
            await appendToolActivity(ctx, session, {
              event: "reply_sent",
              sourceKind: "message",
              peerId: toAgentId,
              summary: `Replied from main session to ${toAgentId}`,
              preview: content
            });
            injectVisibleMainSessionNote(
              session,
              `DM reply sent to ${toAgentId}. / 已向 ${toAgentId} 发送私信回复。`
            );
            await appendHandledInboxActivity(ctx, session, handled);
            return {
              account: summarizeAccount(session),
              delivery
            };
          }
          case "send_to_owner": {
            const content = readRequiredString(rawParams, "content");
            const msgType = readOptionalString(rawParams, "msgType") ?? undefined;
            const delivery = (
              await session.server.sendMessageToOwner(token, content, msgType, signal)
            ).data;
            await appendToolActivity(ctx, session, {
              event: "reply_sent",
              sourceKind: "message",
              peerId: session.account.ownerUserId || "owner",
              summary: "Sent DM to bound owner from main session",
              preview: content
            });
            injectVisibleMainSessionNote(
              session,
              `Owner DM sent. / 已向绑定主人发送私信。`
            );
            return {
              account: summarizeAccount(session),
              delivery
            };
          }
          default:
            throw new ToolInputError(`Unsupported clawbond_dm action: ${action}`);
        }
      });

      return jsonToolResult(`ClawBond DM action ${action} completed.`, details);
    }
  };
}

function createActivityTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_activity",
    label: "ClawBond Activity",
    description:
      "Inspect recent ClawBond realtime/plugin activity, pending main-session inbox work, and any legacy background runs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "summary | recent | active | pending"
        },
        accountId: accountIdProperty,
        limit: limitProperty
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams) => {
      const action = readRequiredString(rawParams, "action");
      const accountId = readOptionalString(rawParams, "accountId") ?? ctx.agentAccountId ?? null;
      ensureToolAccess(ctx, "clawbond_activity", "read", accountId);
      const limit = clampLimit(readOptionalNumber(rawParams, "limit"), 5, 50);
      const snapshot = loadClawBondActivitySnapshot(ctx.config, accountId);

      if (!snapshot) {
        return jsonToolResult("No local ClawBond activity snapshot is available.", {
          accountId: accountId ?? "default",
          activeSessions: [],
          recentEntries: []
        });
      }

      switch (action) {
        case "summary":
          return jsonToolResult("ClawBond activity summary loaded.", {
            accountId: snapshot.accountId,
            agentId: snapshot.agentId,
            activeSessions: snapshot.activeSessions,
            pendingTraces: snapshot.pendingTraces.slice(-limit),
            recentEntries: snapshot.recentEntries.slice(-limit)
          });
        case "recent":
          return jsonToolResult("ClawBond recent activity loaded.", {
            accountId: snapshot.accountId,
            recentEntries: snapshot.recentEntries.slice(-limit)
          });
        case "active":
          return jsonToolResult("ClawBond active legacy background sessions loaded.", {
            accountId: snapshot.accountId,
            activeSessions: snapshot.activeSessions.slice(0, limit)
          });
        case "pending":
          return jsonToolResult("ClawBond pending trace summary loaded.", {
            accountId: snapshot.accountId,
            pendingMainInboxCount: snapshot.pendingMainInboxCount,
            pendingTraces: snapshot.pendingTraces.slice(-limit)
          });
        default:
          throw new ToolInputError(`Unsupported clawbond_activity action: ${action}`);
      }
    }
  };
}

function createNotificationsTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_notifications",
    label: "ClawBond Notifications",
    description:
      "List, count, mark read, or send ClawBond notifications between the bound human and agent.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "list | count | mark_read | send"
        },
        accountId: accountIdProperty,
        page: {
          type: "number",
          description: "Page number for action=list"
        },
        limit: limitProperty,
        notificationId: {
          type: "string",
          description: "Required for action=mark_read"
        },
        content: {
          type: "string",
          description: "Required for action=send"
        },
        type: {
          type: "string",
          description: "Optional notification type for action=send: text | learn | attention"
        }
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const accountId = readOptionalString(rawParams, "accountId") ?? ctx.agentAccountId;
      ensureToolAccess(ctx, "clawbond_notifications", "write", accountId);
      const action = readRequiredString(rawParams, "action");
      const session = new ClawBondToolSession(ctx.config, accountId);
      const page = clampLimit(readOptionalNumber(rawParams, "page"), 1, 10000);
      const limit = clampLimit(readOptionalNumber(rawParams, "limit"), 20);

      const details = await session.withAgentToken(`clawbond_notifications:${action}`, async (token) => {
        switch (action) {
          case "list": {
            const result = await session.server.listNotifications(token, page, limit, signal);
            return {
              account: summarizeAccount(session),
              notifications: result.data,
              pagination: result.pagination
            };
          }
          case "count":
            return {
              account: summarizeAccount(session),
              unreadCount: (await session.server.getUnreadNotificationCount(token, signal)).data
            };
          case "mark_read":
            {
              const notificationId = readRequiredString(rawParams, "notificationId");
              const markedRead = (
                await session.server.markNotificationRead(token, notificationId, signal)
              ).data;
              const handled = await new ClawBondInboxStore(
                session.account.stateRoot
              ).markHandledByNotification(
                session.account.accountId,
                notificationId
              );
              await appendHandledInboxActivity(ctx, session, handled);
              injectVisibleMainSessionNote(session,
                `Notification marked read. / 已将通知标记为已读。`
              );
              return {
                account: summarizeAccount(session),
                markedRead
              };
            }
          case "send":
            {
              const content = readRequiredString(rawParams, "content");
              const type = readOptionalString(rawParams, "type") ?? undefined;
              const sent = (await session.server.sendNotification(token, content, type, signal)).data;
              const handled = await new ClawBondInboxStore(
                session.account.stateRoot
              ).markLatestPendingBySourceKind(
                session.account.accountId,
                "notification",
                content
              );
              const handledNotificationIds = handled
                .map((item) => item.notificationId?.trim() || "")
                .filter(Boolean);
              await Promise.allSettled(
                handledNotificationIds.map((notificationId) =>
                  session.server.markNotificationRead(token, notificationId, signal)
                )
              );
              await appendToolActivity(ctx, session, {
                event: "notification_reply_sent",
                sourceKind: "notification",
                peerId: "notification",
                summary: "Sent notification follow-up from main session",
                preview: content
              });
              injectVisibleMainSessionNote(session,
                `Notification follow-up sent. / 已发送通知回复。`
              );
              await appendHandledInboxActivity(ctx, session, handled);
              return {
                account: summarizeAccount(session),
                sent,
                markedReadNotificationIds: handledNotificationIds
              };
            }
          default:
            throw new ToolInputError(`Unsupported clawbond_notifications action: ${action}`);
        }
      });

      return jsonToolResult(`ClawBond notifications action ${action} completed.`, details);
    }
  };
}

function createConnectionRequestsTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_connection_requests",
    label: "ClawBond Connection Requests",
    description:
      "List, create, or respond to ClawBond connection requests for human handoff workflows.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "list | create | respond"
        },
        accountId: accountIdProperty,
        requestId: {
          type: "string",
          description: "Required for action=respond"
        },
        conversationId: {
          type: "string",
          description: "Required for action=create; optional filter for action=list"
        },
        toAgentId: {
          type: "string",
          description: "Required for action=create"
        },
        status: {
          type: "string",
          description: "Optional filter for action=list: pending | accepted | rejected"
        },
        responseAction: {
          type: "string",
          description: "Required for action=respond: accept | reject"
        },
        message: {
          type: "string",
          description: "Optional message for create/respond"
        }
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const accountId = readOptionalString(rawParams, "accountId") ?? ctx.agentAccountId;
      ensureToolAccess(ctx, "clawbond_connection_requests", "write", accountId);
      const action = readRequiredString(rawParams, "action");
      const session = new ClawBondToolSession(ctx.config, accountId);

      const details = await session.withAgentToken(
        `clawbond_connection_requests:${action}`,
        async (token) => {
          switch (action) {
            case "list": {
              const result = await session.server.listConnectionRequests(
                token,
                {
                  conversationId: readOptionalString(rawParams, "conversationId") ?? undefined,
                  status: readOptionalString(rawParams, "status") ?? undefined
                },
                signal
              );
              return {
                account: summarizeAccount(session),
                requests: result.data
              };
            }
            case "create":
              return {
                account: summarizeAccount(session),
                created: (
                  await session.server.createConnectionRequest(
                    token,
                    {
                      conversation_id: readRequiredString(rawParams, "conversationId"),
                      to_agent_id: readRequiredString(rawParams, "toAgentId"),
                      message: readOptionalString(rawParams, "message")
                    },
                    signal
                  )
                ).data
              };
            case "respond": {
              const responseAction = readRequiredString(rawParams, "responseAction");
              if (responseAction !== "accept" && responseAction !== "reject") {
                throw new ToolInputError("responseAction must be accept or reject");
              }

              const requestId = readRequiredString(rawParams, "requestId");
              const responseMessage = readOptionalString(rawParams, "message");
              const responded = (
                await session.server.respondConnectionRequest(
                  token,
                  requestId,
                  {
                    action: responseAction,
                    message: responseMessage
                  },
                  signal
                )
              ).data;
              const handled = await new ClawBondInboxStore(
                session.account.stateRoot
              ).markHandledByRequest(
                session.account.accountId,
                requestId,
                responseMessage || responseAction
              );
              await appendHandledInboxActivity(ctx, session, handled);
              injectVisibleMainSessionNote(session,
                `Connection request ${responseAction}ed. / 连接请求已${responseAction === "accept" ? "接受" : "拒绝"}。`
              );

              return {
                account: summarizeAccount(session),
                responded
              };
            }
            default:
              throw new ToolInputError(
                `Unsupported clawbond_connection_requests action: ${action}`
              );
          }
        }
      );

      return jsonToolResult(`ClawBond connection request action ${action} completed.`, details);
    }
  };
}

function summarizeAccount(session: ClawBondToolSession) {
  return {
    accountId: session.account.accountId,
    agentId: session.account.agentId,
    agentName: session.account.agentName,
    bindingStatus: session.account.bindingStatus,
    platformBaseUrl: session.account.apiBaseUrl || session.account.serverUrl,
    socialBaseUrl: session.account.socialBaseUrl || undefined
  };
}

async function appendToolActivity(
  ctx: OpenClawPluginToolContext,
  session: ClawBondToolSession,
  params: {
    event:
      | "reply_sent"
      | "notification_reply_sent"
      | "pending_handled";
    sourceKind: "message" | "notification" | "connection_request";
    itemId?: string;
    traceId?: string;
    peerId: string;
    summary: string;
    conversationId?: string;
    deliveryPath?: ClawBondPendingInboxItem["deliveryPath"];
    preview?: string;
  }
) {
  try {
    const store = new ClawBondActivityStore(session.account.stateRoot);
    await store.append(session.account.accountId, {
      agentId: session.account.agentId,
      sessionKey: ctx.sessionKey?.trim() || "agent:main:main",
      itemId: params.itemId,
      traceId: params.traceId,
      conversationId: params.conversationId,
      peerId: params.peerId,
      peerLabel: params.peerId,
      deliveryPath: params.deliveryPath,
      sourceKind: params.sourceKind,
      event: params.event,
      summary: params.summary,
      preview: params.preview?.trim() || undefined
    });
  } catch {
    return;
  }
}

async function appendHandledInboxActivity(
  ctx: OpenClawPluginToolContext,
  session: ClawBondToolSession,
  handledItems: ClawBondPendingInboxItem[]
) {
  for (const item of handledItems) {
    await appendToolActivity(ctx, session, {
      event: "pending_handled",
      sourceKind: normalizeHandledSourceKind(item.sourceKind),
      itemId: item.id,
      traceId: item.traceId,
      peerId: item.peerId,
      conversationId: item.conversationId,
      deliveryPath: item.deliveryPath,
      summary: `Marked pending ${formatPendingItemKind(item)} from ${item.peerLabel} as handled in main session`,
      preview: item.responsePreview || undefined
    });
  }
}

function normalizeHandledSourceKind(
  sourceKind: ClawBondPendingInboxItem["sourceKind"]
): "message" | "notification" | "connection_request" {
  return sourceKind === "connection_request_response" ? "connection_request" : sourceKind;
}

function formatPendingItemKind(item: ClawBondPendingInboxItem): string {
  return item.sourceKind === "message" ? "DM" : item.sourceKind.replace(/_/g, " ");
}

function injectVisibleMainSessionNote(session: ClawBondToolSession, message: string) {
  if (!session.account.visibleMainSessionNotes) {
    return;
  }

  queueMainSessionVisibleNote(message, { label: "ClawBond" });
}

function readStringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const candidate = value as Record<string, unknown>;
  const entry = candidate[key];
  return typeof entry === "string" ? entry.trim() : "";
}
