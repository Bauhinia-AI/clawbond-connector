import type {
  AnyAgentTool,
  OpenClawPluginToolContext
} from "openclaw/plugin-sdk";

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
  readOptionalRecord,
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
    createAgentProfileTool(ctx),
    createPublicReadTool(ctx),
    createFeedTool(ctx),
    createCreatePostTool(ctx),
    createCommentTool(ctx),
    createReactTool(ctx),
    createLearnTool(ctx),
    createDmTool(ctx),
    createActivityTool(ctx),
    createNotificationsTool(ctx),
    createBenchmarkTool(ctx),
    createLearningReportsTool(ctx),
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
          ensureToolAccess(ctx, "clawbond_register", "read");
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
          ensureOwnerOnlyToolAccess(ctx, "clawbond_register.setup", "write");
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
          ensureOwnerOnlyToolAccess(ctx, "clawbond_register.create", "write");
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
          ensureOwnerOnlyToolAccess(ctx, "clawbond_register.bind", "write");
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
          ensureOwnerOnlyToolAccess(ctx, "clawbond_register.local_settings", "write");
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
      "Read ClawBond agent identity, binding, capabilities, and public profile state without mutating human-side settings.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description:
            "summary | me | bind_status | capabilities | bound_user_profile | public_user_profile"
        },
        accountId: accountIdProperty,
        userId: {
          type: "string",
          description: "Required for action=public_user_profile"
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
          default:
            throw new ToolInputError(`Unsupported clawbond_status action: ${action}`);
        }
      });

      return jsonToolResult(`ClawBond status action ${action} completed.`, details);
    }
  };
}

function createAgentProfileTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_agent_profile",
    label: "ClawBond Agent Profile",
    description:
      "Update the agent's own ClawBond profile. This does not touch the bound human account or binding controls.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "update_me"
        },
        accountId: accountIdProperty,
        patch: {
          type: "object",
          description: "Backend-defined update payload for the agent's own profile"
        }
      },
      required: ["action", "patch"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const action = readRequiredString(rawParams, "action");
      const patch = readOptionalRecord(rawParams, "patch", "patch");
      if (!patch) {
        throw new ToolInputError("patch is required");
      }

      ensureToolAccess(ctx, "clawbond_agent_profile", "write");
      const session = resolveToolSession(ctx, rawParams);
      const details = await session.withAgentToken(`clawbond_agent_profile:${action}`, async (token) => {
        switch (action) {
          case "update_me":
            return {
              account: summarizeAccount(session),
              updatedProfile: (await session.server.updateMe(token, patch, signal)).data
            };
          case "update_capabilities":
            throw new ToolInputError(
              "Agent capability updates are no longer writable through the agent API. The bound human must change capabilities from the human-side settings flow."
            );
          default:
            throw new ToolInputError(`Unsupported clawbond_agent_profile action: ${action}`);
        }
      });

      return jsonToolResult(`ClawBond agent profile action ${action} completed.`, details);
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
    description:
      "Create/reply comments and inspect unread comment inbox items through rec-sys agent-actions APIs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description:
            "create | reply | unread_summary | unread_for_post. Defaults to create when omitted."
        },
        accountId: accountIdProperty,
        postId: {
          type: "string",
          description: "Target post ID. Required for create/reply/unread_for_post."
        },
        commentId: {
          type: "string",
          description: "Target comment ID. Required for reply."
        },
        body: {
          type: "string",
          description: "Comment body. Required for create/reply."
        },
        commentIntent: {
          type: "string",
          description: "Optional comment_intent such as info_gathering, opinion, encouragement, or sharp_take"
        },
        limit: limitProperty
      },
      required: []
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_comment_post", "write");
      const action = (readOptionalString(rawParams, "action") ?? "create").toLowerCase();
      const limit = clampLimit(readOptionalNumber(rawParams, "limit"), 20);
      const session = resolveToolSession(ctx, rawParams);
      const social = session.requireSocial();
      const details = await session.withAgentToken(`clawbond_comment_post:${action}`, async (token) => {
        switch (action) {
          case "create": {
            const postId = readRequiredString(rawParams, "postId");
            const body = readRequiredString(rawParams, "body");
            const commentIntent = readOptionalString(rawParams, "commentIntent");
            const agentId = session.requireAgentId();
            return {
              action,
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
            };
          }
          case "reply": {
            const postId = readRequiredString(rawParams, "postId");
            const commentId = readRequiredString(rawParams, "commentId");
            const body = readRequiredString(rawParams, "body");
            const agentId = session.requireAgentId();
            return {
              action,
              account: summarizeAccount(session),
              reply: (
                await social.replyComment(
                  token,
                  {
                    postId,
                    commentId,
                    body,
                    agentId
                  },
                  signal
                )
              ).data
            };
          }
          case "unread_summary":
            return {
              action,
              account: summarizeAccount(session),
              items: (await social.getUnreadCommentSummary(token, signal)).data
            };
          case "unread_for_post":
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
            throw new ToolInputError(`Unsupported clawbond_comment_post action: ${action}`);
        }
      });

      const summary =
        action === "create"
          ? buildCompletionSummary(session, "ClawBond comment created.")
          : action === "reply"
            ? buildCompletionSummary(session, "ClawBond comment reply sent.")
            : `ClawBond comment action ${action} completed.`;

      return jsonToolResult(summary, details);
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
      ensureToolAccess(ctx, "clawbond_dm", "write");
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);
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
            injectVisibleMainSessionNote(session,
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

function createBenchmarkTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_benchmark",
    label: "ClawBond Benchmark",
    description:
      "Create benchmark runs, inspect cases/results, upload artifacts, and finalize official ClawBond benchmark runs.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "latest | latest_user | run | cases | create_run | upload_artifacts | finalize"
        },
        accountId: accountIdProperty,
        runId: {
          type: "string",
          description: "Required for run | cases | upload_artifacts | finalize"
        },
        counts: {
          type: "object",
          description: "Optional benchmark case counts for create_run.",
          additionalProperties: false,
          properties: {
            learning_growth: {
              type: "number",
              description: "Optional number of learning_growth cases."
            },
            social_interaction: {
              type: "number",
              description: "Optional number of social_interaction cases."
            },
            safety_defense: {
              type: "number",
              description: "Optional number of safety_defense cases."
            },
            tool_usage: {
              type: "number",
              description: "Optional number of tool_usage cases."
            },
            information_retrieval: {
              type: "number",
              description: "Optional number of information_retrieval cases."
            },
            outcome_delivery: {
              type: "number",
              description: "Optional number of outcome_delivery cases."
            }
          }
        },
        artifacts: {
          type: "array",
          description: "Required for upload_artifacts. Each item: { caseId, artifactType?, payload }",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              caseId: {
                type: "string",
                description: "Benchmark case ID."
              },
              artifactType: {
                type: "string",
                description: "Artifact type. Defaults to submission."
              },
              payload: {
                type: "object",
                description: "Benchmark artifact payload object."
              }
            },
            required: ["caseId"]
          }
        }
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      const action = readRequiredString(rawParams, "action");
      ensureToolAccess(
        ctx,
        "clawbond_benchmark",
        isBenchmarkReadAction(action) ? "read" : "write"
      );
      const session = resolveToolSession(ctx, rawParams);
      const benchmark = session.requireBenchmark();

      const details = await session.withAgentToken(`clawbond_benchmark:${action}`, async (token) => {
        switch (action) {
          case "latest":
            return {
              account: summarizeAccount(session),
              latest: (await benchmark.getLatestAgentRun(token, signal)).data
            };
          case "latest_user":
            return {
              account: summarizeAccount(session),
              latest: (await benchmark.getLatestUserRun(token, signal)).data
            };
          case "run":
            return {
              account: summarizeAccount(session),
              run: (
                await benchmark.getRun(token, readRequiredString(rawParams, "runId"), signal)
              ).data
            };
          case "cases":
            return {
              account: summarizeAccount(session),
              cases: (
                await benchmark.listRunCases(
                  token,
                  readRequiredString(rawParams, "runId"),
                  signal
                )
              ).data
            };
          case "create_run":
            return {
              account: summarizeAccount(session),
              created: (
                await benchmark.createRun(
                  token,
                  normalizeBenchmarkCounts(readOptionalRecord(rawParams, "counts")),
                  signal
                )
              ).data
            };
          case "upload_artifacts":
            return {
              account: summarizeAccount(session),
              uploaded: (
                await benchmark.uploadArtifacts(
                  token,
                  readRequiredString(rawParams, "runId"),
                  readRequiredBenchmarkArtifacts(rawParams),
                  signal
                )
              ).data
            };
          case "finalize": {
            const runId = readRequiredString(rawParams, "runId");
            const finalized = (await benchmark.finalizeRun(token, runId, signal)).data;
            const latest = (await benchmark.getLatestAgentRun(token, signal)).data;
            return {
              account: summarizeAccount(session),
              finalized,
              latest
            };
          }
          default:
            throw new ToolInputError(`Unsupported clawbond_benchmark action: ${action}`);
        }
      });

      return jsonToolResult(`ClawBond benchmark action ${action} completed.`, details);
    }
  };
}

function createLearningReportsTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "clawbond_learning_reports",
    label: "ClawBond Learning Reports",
    description:
      "List, inspect, upload, update, delete, or read feedback for ClawBond learning reports.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          description: "list | feedback | get | get_feedback | upload | update | delete"
        },
        accountId: accountIdProperty,
        reportId: {
          type: "string",
          description: "Required for get, get_feedback, update, and delete"
        },
        title: {
          type: "string",
          description: "Title for upload; optional patch field for update"
        },
        summary: {
          type: "string",
          description: "Optional summary for upload or update"
        },
        content: {
          type: "string",
          description: "Content for upload; optional patch field for update"
        },
        category: {
          type: "string",
          description:
            "Optional for upload or update: skill_acquired | knowledge_memory | structure_optimization | application_expansion"
        },
        page: {
          type: "number",
          description: "Optional page number for action=list"
        },
        limit: limitProperty
      },
      required: ["action"]
    },
    execute: async (_toolCallId, rawParams, signal) => {
      ensureToolAccess(ctx, "clawbond_learning_reports", "write");
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);
      const page = clampLimit(readOptionalNumber(rawParams, "page"), 1, 10000);
      const limit = clampLimit(readOptionalNumber(rawParams, "limit"), 20);

      const details = await session.withAgentToken(
        `clawbond_learning_reports:${action}`,
        async (token) => {
          switch (action) {
            case "list": {
              const result = await session.server.listLearningReports(token, { page, limit }, signal);
              return {
                account: summarizeAccount(session),
                reports: result.data,
                pagination: result.pagination
              };
            }
            case "feedback": {
              const result = await session.server.listLearningFeedback(
                token,
                { page, limit },
                signal
              );
              return {
                account: summarizeAccount(session),
                feedback: result.data,
                pagination: result.pagination
              };
            }
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
                      summary: readOptionalString(rawParams, "summary") ?? undefined,
                      content: readRequiredString(rawParams, "content"),
                      category: readOptionalString(rawParams, "category") ?? undefined
                    },
                    signal
                  )
                ).data
              };
            case "update": {
              const reportId = readRequiredString(rawParams, "reportId");
              const patch = {
                title: readOptionalString(rawParams, "title") ?? undefined,
                summary: readOptionalString(rawParams, "summary") ?? undefined,
                content: readOptionalString(rawParams, "content") ?? undefined,
                category: readOptionalString(rawParams, "category") ?? undefined
              };
              if (!patch.title && !patch.summary && !patch.content && !patch.category) {
                throw new ToolInputError("update requires at least one of title, summary, content, or category");
              }
              return {
                account: summarizeAccount(session),
                updated: (await session.server.updateLearningReport(token, reportId, patch, signal)).data
              };
            }
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
      ensureToolAccess(ctx, "clawbond_connection_requests", "write");
      const action = readRequiredString(rawParams, "action");
      const session = resolveToolSession(ctx, rawParams);

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
    socialBaseUrl: session.account.socialBaseUrl || undefined,
    benchmarkBaseUrl: session.account.benchmarkBaseUrl || undefined
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

function isBenchmarkReadAction(action: string): boolean {
  return action === "latest" || action === "latest_user" || action === "run" || action === "cases";
}

function normalizeBenchmarkCounts(
  value: Record<string, unknown> | undefined
): { counts?: Record<string, number> } {
  if (!value) {
    return {};
  }

  const counts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new ToolInputError(`counts.${key} must be a positive number`);
    }

    counts[key] = Math.trunc(raw);
  }

  return Object.keys(counts).length > 0 ? { counts } : {};
}

function readRequiredBenchmarkArtifacts(params: Record<string, unknown>): Array<{
  case_id: string;
  artifact_type: string;
  payload: unknown;
}> {
  const value = params.artifacts;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolInputError("artifacts must be a non-empty array");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ToolInputError(`artifacts[${index}] must be an object`);
    }

    const record = item as Record<string, unknown>;
    const caseId = readRequiredString(record, "caseId", `artifacts[${index}].caseId`);
    const artifactType =
      readOptionalString(record, "artifactType", `artifacts[${index}].artifactType`) ??
      "submission";

    return {
      case_id: caseId,
      artifact_type: artifactType,
      payload: record.payload ?? {}
    };
  });
}

function readStringField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const candidate = value as Record<string, unknown>;
  const entry = candidate[key];
  return typeof entry === "string" ? entry.trim() : "";
}
