import type {
  AnyAgentTool,
  OpenClawPluginToolContext
} from "openclaw/plugin-sdk";

import { ClawBondActivityStore } from "./activity-store.ts";
import { ClawBondToolSession } from "./clawbond-api.ts";
import { loadClawBondActivitySnapshot } from "./clawbond-assist.ts";
import { ClawBondInboxStore } from "./inbox-store.ts";
import { queueMainSessionVisibleNote } from "./openclaw-cli.ts";
import type { ClawBondPendingInboxItem } from "./types.ts";
import {
  ToolInputError,
  clampLimit,
  ensureToolAccess,
  jsonToolResult,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalRecord,
  readOptionalString,
  readRequiredString
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
    createStatusTool(ctx),
    createPublicReadTool(ctx),
    createFeedTool(ctx),
    createCreatePostTool(ctx),
    createCommentTool(ctx),
    createReactTool(ctx),
    createLearnTool(ctx),
    createDmTool(ctx),
    createActivityTool(ctx),
    createNotificationsTool(ctx),
    createLearningReportsTool(ctx),
    createConnectionRequestsTool(ctx)
  ];
}

function createStatusTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_status",
    label: "ClawBond Status",
    description:
      "Inspect or update ClawBond agent identity, binding, capabilities, and profile state.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description:
            "summary | me | bind_status | capabilities | bound_user_profile | public_user_profile | update_me | update_bound_user_profile | update_capabilities | rotate_bind_code | unbind"
        },
        accountId: accountIdProperty,
        userId: {
          type: "string",
          description: "Required for action=public_user_profile"
        },
        patch: {
          type: "object",
          description: "Backend-defined update payload for update_* actions"
        }
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_status");
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);

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
          case "bound_user_profile":
            return {
              account: summarizeAccount(session),
              boundUserProfile: (await session.server.getBoundUserProfile(token, signal)).data
            };
          case "public_user_profile": {
            const userId = readRequiredString(rawParams, "userId");
            return {
              account: summarizeAccount(session),
              userProfile: (await session.server.getUserProfile(token, userId, signal)).data
            };
          }
          case "update_me": {
            ensureToolAccess(ctx, "update_me", "write");
            const patch = readOptionalRecord(rawParams, "patch", "patch");
            if (!patch) {
              throw new ToolInputError("patch is required for action=update_me");
            }
            return {
              account: summarizeAccount(session),
              updatedProfile: (await session.server.updateMe(token, patch, signal)).data
            };
          }
          case "update_bound_user_profile": {
            ensureToolAccess(ctx, "update_bound_user_profile", "write");
            const patch = readOptionalRecord(rawParams, "patch", "patch");
            if (!patch) {
              throw new ToolInputError("patch is required for action=update_bound_user_profile");
            }
            return {
              account: summarizeAccount(session),
              updatedBoundUserProfile: (
                await session.server.updateBoundUserProfile(token, patch, signal)
              ).data
            };
          }
          case "update_capabilities": {
            ensureToolAccess(ctx, "update_capabilities", "write");
            const patch = readOptionalRecord(rawParams, "patch", "patch");
            if (!patch) {
              throw new ToolInputError("patch is required for action=update_capabilities");
            }
            return {
              account: summarizeAccount(session),
              updatedCapabilities: (await session.server.updateCapabilities(token, patch, signal)).data
            };
          }
          case "rotate_bind_code": {
            ensureToolAccess(ctx, "rotate_bind_code", "write");
            return {
              account: summarizeAccount(session),
              rotated: (await session.server.rotateBindCode(token, signal)).data
            };
          }
          case "unbind": {
            ensureToolAccess(ctx, "unbind", "write");
            return {
              account: summarizeAccount(session),
              unbound: (await session.server.unbindAgent(token, signal)).data
            };
          }
          default:
            throw new ToolInputError(`Unsupported clawbond_status action: ${action}`);
        }
      });

      return jsonToolResult(`ClawBond status action ${action} completed.`, details);
    }
  };
}

function createPublicReadTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_public_read",
    label: "ClawBond Public Read",
    description:
      "Read ClawBond public discovery surfaces such as search, tags, topics, hotspots, and post learners.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description:
            "search_posts | search_tags | tag_categories | tag_posts | post_learners | hot_tags | hot_posts | topics | topic_detail"
        },
        accountId: accountIdProperty,
        query: {
          type: "string",
          description: "Required for search_posts and search_tags"
        },
        tagId: {
          type: "string",
          description: "Required for tag_posts and topic_detail"
        },
        postId: {
          type: "string",
          description: "Required for post_learners"
        }
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);
      const social = session.requireSocial();

      const details = await (async () => {
        switch (action) {
          case "search_posts":
            return {
              action,
              results: (await social.searchPublicPosts(readRequiredString(rawParams, "query"), signal)).data
            };
          case "search_tags":
            return {
              action,
              results: (await social.searchTags(readRequiredString(rawParams, "query"), signal)).data
            };
          case "tag_categories":
            return { action, results: (await social.listTagCategories(signal)).data };
          case "tag_posts":
            return {
              action,
              results: (await social.listTagPosts(readRequiredString(rawParams, "tagId"), signal)).data
            };
          case "post_learners":
            return {
              action,
              results: (await social.getPostLearners(readRequiredString(rawParams, "postId"), signal)).data
            };
          case "hot_tags":
            return { action, results: (await social.getHotTags(signal)).data };
          case "hot_posts":
            return { action, results: (await social.getHotPosts(signal)).data };
          case "topics":
            return { action, results: (await social.listTopics(signal)).data };
          case "topic_detail":
            return {
              action,
              result: (await social.getTopicDetail(readRequiredString(rawParams, "tagId"), signal)).data
            };
          default:
            throw new ToolInputError(`Unsupported clawbond_public_read action: ${action}`);
        }
      })();

      return jsonToolResult(`ClawBond public read action ${action} completed.`, details);
    }
  };
}

function createFeedTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_get_feed",
    label: "ClawBond Feed",
    description:
      "Read authenticated ClawBond social feeds, owner-post views, and unread comment inboxes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description:
            "agent | tag | mixed | latest | search | owner_posts | unread_comment_summary | unread_comments_for_post"
        },
        accountId: accountIdProperty,
        tagId: {
          type: "string",
          description: "Required for action=tag"
        },
        query: {
          type: "string",
          description: "Required for action=search"
        },
        postId: {
          type: "string",
          description: "Required for action=unread_comments_for_post"
        },
        limit: limitProperty
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_get_feed");
      const action = readRequiredString(rawParams, "action");
      const limit = clampLimit(readOptionalNumber(rawParams, "limit"), 20);
      const session = resolveToolSession(ctx, rawParams);
      const social = session.requireSocial();

      const details = await session.withAgentToken(`clawbond_get_feed:${action}`, async (token) => {
        switch (action) {
          case "agent":
            return {
              action,
              account: summarizeAccount(session),
              items: (await social.getAgentFeed(token, limit, signal)).data
            };
          case "tag":
            return {
              action,
              account: summarizeAccount(session),
              items: (
                await social.getAgentTagFeed(token, readRequiredString(rawParams, "tagId"), limit, signal)
              ).data
            };
          case "mixed":
            return {
              action,
              account: summarizeAccount(session),
              items: (await social.getMixedFeed(token, limit, signal)).data
            };
          case "latest":
            return {
              action,
              account: summarizeAccount(session),
              items: (await social.getLatestPosts(token, limit, signal)).data
            };
          case "search":
            return {
              action,
              account: summarizeAccount(session),
              items: (
                await social.searchAgentPosts(token, readRequiredString(rawParams, "query"), limit, signal)
              ).data
            };
          case "owner_posts":
            return {
              action,
              account: summarizeAccount(session),
              items: (await social.listOwnerPosts(token, limit, signal)).data
            };
          case "unread_comment_summary":
            return {
              action,
              account: summarizeAccount(session),
              items: (await social.getUnreadCommentSummary(token, signal)).data
            };
          case "unread_comments_for_post":
            return {
              action,
              account: summarizeAccount(session),
              items: (
                await social.getUnreadCommentsForPost(
                  token,
                  readRequiredString(rawParams, "postId"),
                  limit,
                  signal
                )
              ).data
            };
          default:
            throw new ToolInputError(`Unsupported clawbond_get_feed action: ${action}`);
        }
      });

      return jsonToolResult(`ClawBond feed action ${action} completed.`, details);
    }
  };
}

function createCreatePostTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_create_post",
    label: "ClawBond Create Post",
    description: "Publish a ClawBond post through the rec-sys agent-actions API.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: accountIdProperty,
        title: {
          type: "string",
          description: "Post title"
        },
        body: {
          type: "string",
          description: "Post body"
        }
      },
      required: ["title", "body"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_create_post", "write");
      const session = resolveToolSession(ctx, rawParams);
      const social = session.requireSocial();
      const title = readRequiredString(rawParams, "title");
      const body = readRequiredString(rawParams, "body");
      const agentId = session.requireAgentId();

      const details = await session.withAgentToken("clawbond_create_post", async (token) => ({
        account: summarizeAccount(session),
        createdPost: (
          await social.createPost(
            token,
            {
              title,
              body,
              agentId
            },
            signal
          )
        ).data
      }));

      return jsonToolResult(buildCompletionSummary(session, "ClawBond post created."), details);
    }
  };
}

function createCommentTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_comment_post",
    label: "ClawBond Comment",
    description: "Comment on a ClawBond post through the rec-sys agent-actions API.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: accountIdProperty,
        postId: {
          type: "string",
          description: "Target post ID"
        },
        body: {
          type: "string",
          description: "Comment body"
        },
        commentIntent: {
          type: "string",
          description: "Optional comment_intent such as info_gathering, opinion, encouragement, or sharp_take"
        }
      },
      required: ["postId", "body"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_comment_post", "write");
      const session = resolveToolSession(ctx, rawParams);
      const social = session.requireSocial();
      const postId = readRequiredString(rawParams, "postId");
      const body = readRequiredString(rawParams, "body");
      const commentIntent = readOptionalString(rawParams, "commentIntent");
      const agentId = session.requireAgentId();

      const details = await session.withAgentToken("clawbond_comment_post", async (token) => ({
        account: summarizeAccount(session),
        createdComment: (
          await social.createComment(
            token,
            {
              postId,
              body,
              agentId,
              comment_intent: commentIntent
            },
            signal
          )
        ).data
      }));

      return jsonToolResult(buildCompletionSummary(session, "ClawBond comment created."), details);
    }
  };
}

function createReactTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_react_post",
    label: "ClawBond React",
    description: "Like/unlike or favorite/unfavorite a ClawBond post.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: accountIdProperty,
        postId: {
          type: "string",
          description: "Target post ID"
        },
        reaction: {
          type: "string",
          description: "like | favorite"
        },
        remove: {
          type: "boolean",
          description: "Set true to remove the reaction instead of adding it"
        }
      },
      required: ["postId", "reaction"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_react_post", "write");
      const session = resolveToolSession(ctx, rawParams);
      const social = session.requireSocial();
      const postId = readRequiredString(rawParams, "postId");
      const reaction = readRequiredString(rawParams, "reaction");
      const remove = readOptionalBoolean(rawParams, "remove") ?? false;
      const agentId = session.requireAgentId();

      const details = await session.withAgentToken("clawbond_react_post", async (token) => {
        const payload = { postId, agentId };
        switch (reaction) {
          case "like":
            return {
              account: summarizeAccount(session),
              reaction,
              remove,
              result: (await social.setLike(token, payload, remove, signal)).data
            };
          case "favorite":
            return {
              account: summarizeAccount(session),
              reaction,
              remove,
              result: (await social.setFavorite(token, payload, remove, signal)).data
            };
          default:
            throw new ToolInputError(`Unsupported reaction type: ${reaction}`);
        }
      });

      return jsonToolResult(
        buildCompletionSummary(
          session,
          `ClawBond reaction ${reaction} ${remove ? "removed" : "applied"}.`
        ),
        details
      );
    }
  };
}

function createLearnTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_learn_post",
    label: "ClawBond Learn Post",
    description:
      "Fetch the canonical one-click learning payload for a ClawBond post through rec-sys.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        accountId: accountIdProperty,
        postId: {
          type: "string",
          description: "Target post ID"
        }
      },
      required: ["postId"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_learn_post", "write");
      const session = resolveToolSession(ctx, rawParams);
      const social = session.requireSocial();
      const postId = readRequiredString(rawParams, "postId");
      const agentId = session.requireAgentId();

      const details = await session.withAgentToken("clawbond_learn_post", async (token) => ({
        account: summarizeAccount(session),
        learningPayload: (
          await social.learnPost(
            token,
            {
              postId,
              agentId
            },
            signal
          )
        ).data
      }));

      return jsonToolResult(
        buildCompletionSummary(session, "ClawBond learning payload fetched."),
        details
      );
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
          description: "list_conversations | list_messages | poll | send"
        },
        accountId: accountIdProperty,
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
        limit: limitProperty
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_dm", "write");
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);
      const limit = clampLimit(readOptionalNumber(rawParams, "limit"), 20);

      const details = await session.withAgentToken(`clawbond_dm:${action}`, async (token) => {
        switch (action) {
          case "list_conversations":
            return {
              account: summarizeAccount(session),
              conversations: (await session.server.listConversations(token, signal)).data
            };
          case "list_messages":
            return {
              account: summarizeAccount(session),
              messages: (
                await session.server.listConversationMessages(
                  token,
                  readRequiredString(rawParams, "conversationId"),
                  limit,
                  signal
                )
              ).data
            };
          case "poll":
            return {
              account: summarizeAccount(session),
              messages: (
                await session.server.pollMessages(
                  token,
                  readOptionalString(rawParams, "after"),
                  limit,
                  signal
                )
              ).data
            };
          case "send": {
            const conversationId = readOptionalString(rawParams, "conversationId");
            const content = readRequiredString(rawParams, "content");
            const inboxStore = new ClawBondInboxStore(session.account.stateRoot);
            if (conversationId) {
              const delivery = (
                await session.server.sendConversationMessage(token, conversationId, content, signal)
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
              await session.server.sendFirstMessage(token, toAgentId, content, signal)
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
            injectVisibleMainSessionNote(session,
              `DM reply sent to ${toAgentId}. / 已向 ${toAgentId} 发送私信回复。`
            );
            await appendHandledInboxActivity(ctx, session, handled);
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
          description: "summary | recent | active"
        },
        accountId: accountIdProperty,
        limit: limitProperty
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams) => {
      const action = readRequiredString(rawParams, "action");
      const accountId = readOptionalString(rawParams, "accountId") ?? ctx.agentAccountId ?? null;
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
        }
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_notifications", "write");
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);
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
              const sent = (await session.server.sendNotification(token, content, signal)).data;
              const handled = await new ClawBondInboxStore(
                session.account.stateRoot
              ).markLatestPendingBySourceKind(
                session.account.accountId,
                "notification",
                content
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
                sent
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

function createLearningReportsTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_learning_reports",
    label: "ClawBond Learning Reports",
    description:
      "List, inspect, upload, delete, or read feedback for ClawBond learning reports.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "list | feedback | get | get_feedback | upload | delete"
        },
        accountId: accountIdProperty,
        reportId: {
          type: "string",
          description: "Required for get, get_feedback, and delete"
        },
        title: {
          type: "string",
          description: "Required for upload"
        },
        summary: {
          type: "string",
          description: "Required for upload"
        },
        content: {
          type: "string",
          description: "Required for upload"
        },
        category: {
          type: "string",
          description:
            "Required for upload: skill_acquired | knowledge_memory | structure_optimization | application_expansion"
        }
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_learning_reports", "write");
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);

      const details = await session.withAgentToken(
        `clawbond_learning_reports:${action}`,
        async (token) => {
          switch (action) {
            case "list":
              return {
                account: summarizeAccount(session),
                reports: (await session.server.listLearningReports(token, signal)).data
              };
            case "feedback":
              return {
                account: summarizeAccount(session),
                feedback: (await session.server.getLearningFeedback(token, signal)).data
              };
            case "get":
              return {
                account: summarizeAccount(session),
                report: (
                  await session.server.getLearningReport(
                    token,
                    readRequiredString(rawParams, "reportId"),
                    signal
                  )
                ).data
              };
            case "get_feedback":
              return {
                account: summarizeAccount(session),
                feedback: (
                  await session.server.getLearningReportFeedback(
                    token,
                    readRequiredString(rawParams, "reportId"),
                    signal
                  )
                ).data
              };
            case "upload":
              return {
                account: summarizeAccount(session),
                uploaded: (
                  await session.server.uploadLearningReport(
                    token,
                    {
                      title: readRequiredString(rawParams, "title"),
                      summary: readRequiredString(rawParams, "summary"),
                      content: readRequiredString(rawParams, "content"),
                      category: readRequiredString(rawParams, "category")
                    },
                    signal
                  )
                ).data
              };
            case "delete":
              return {
                account: summarizeAccount(session),
                deleted: (
                  await session.server.deleteLearningReport(
                    token,
                    readRequiredString(rawParams, "reportId"),
                    signal
                  )
                ).data
              };
            default:
              throw new ToolInputError(`Unsupported clawbond_learning_reports action: ${action}`);
          }
        }
      );

      return jsonToolResult(`ClawBond learning report action ${action} completed.`, details);
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
          description: "Required for action=create"
        },
        toAgentId: {
          type: "string",
          description: "Required for action=create"
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
      ensureToolAccess(ctx, "clawbond_connection_requests", "write");
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);

      const details = await session.withAgentToken(
        `clawbond_connection_requests:${action}`,
        async (token) => {
          switch (action) {
            case "list":
              return {
                account: summarizeAccount(session),
                requests: (await session.server.listConnectionRequests(token, signal)).data
              };
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

function resolveToolSession(
  ctx: OpenClawPluginToolContext,
  params: Record<string, unknown>
): ClawBondToolSession {
  return new ClawBondToolSession(
    ctx.config,
    readOptionalString(params, "accountId") ?? ctx.agentAccountId
  );
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

function buildCompletionSummary(session: ClawBondToolSession, baseSummary: string): string {
  const followUp = buildPendingFollowUpHint(session);
  if (!followUp) {
    return baseSummary;
  }

  return `${baseSummary}\n\nFollow-up still needed: ${followUp}`;
}

function buildPendingFollowUpHint(session: ClawBondToolSession): string | undefined {
  const pendingItems = new ClawBondInboxStore(session.account.stateRoot).listPendingSync(
    session.account.accountId,
    5
  );
  if (pendingItems.length === 0) {
    return undefined;
  }

  if (pendingItems.length > 1) {
    return `you still have ${pendingItems.length} pending ClawBond items; send the appropriate ClawBond follow-up before ending this turn.`;
  }

  const [item] = pendingItems;
  switch (item.sourceKind) {
    case "message":
      if (item.conversationId) {
        return `reply to ${item.peerLabel} with \`clawbond_dm\` using conversationId \`${item.conversationId}\` and briefly confirm what you just did.`;
      }
      return `reply to ${item.peerLabel} with \`clawbond_dm\` and briefly confirm what you just did.`;
    case "notification":
      return `send a brief result update with \`clawbond_notifications\` so the originating notification is closed out.`;
    case "connection_request":
    case "connection_request_response":
      if (item.requestKey) {
        return `respond with \`clawbond_connection_requests\` using requestId \`${item.requestKey}\` before ending this turn.`;
      }
      return `respond with \`clawbond_connection_requests\` before ending this turn.`;
    default:
      return `send the appropriate ClawBond follow-up before ending this turn.`;
  }
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
    peerId: string;
    summary: string;
    conversationId?: string;
    preview?: string;
  }
) {
  try {
    const store = new ClawBondActivityStore(session.account.stateRoot);
    await store.append(session.account.accountId, {
      agentId: session.account.agentId,
      sessionKey: ctx.sessionKey?.trim() || "agent:main:main",
      conversationId: params.conversationId,
      peerId: params.peerId,
      peerLabel: params.peerId,
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
      peerId: item.peerId,
      conversationId: item.conversationId,
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
