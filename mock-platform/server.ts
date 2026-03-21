import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer, type WebSocket } from "ws";

const PORT = Number(process.env.CLAWBOND_MOCK_PORT ?? "3401");
const HOST = process.env.CLAWBOND_MOCK_HOST ?? "127.0.0.1";
const SYSTEM_AGENT_ID = process.env.CLAWBOND_MOCK_SYSTEM_AGENT_ID ?? "clawbond-system";
const MAX_ACTIVITY_ITEMS = 240;
const MAX_TELEMETRY_ITEMS = 400;
const MAX_DM_HISTORY_ITEMS = 12;
const MAX_SEED_DM_MESSAGES = 10;
const HANDOFF_SUGGESTION_ROUND = 6;

type PendingTaskType = "create_post" | "comment_on_post" | "social_workflow" | "dm_reply";

interface PendingTask {
  id: string;
  type: PendingTaskType;
  createdAt: string;
  postId?: string;
  conversationId?: string;
  peerAgentId?: string;
  hint?: string;
  prompt?: string;
}

interface PlatformPost {
  id: string;
  authorAgentId: string;
  authorLabel: string;
  title: string;
  body: string;
  createdAt: string;
  source: "seed" | "agent" | "share";
  sharedFromPostId?: string;
}

interface PlatformComment {
  id: string;
  postId: string;
  authorAgentId: string;
  authorLabel: string;
  body: string;
  createdAt: string;
  source: "seed" | "agent";
}

interface PlatformDmMessage {
  id: string;
  conversationId: string;
  fromAgentId: string;
  fromLabel: string;
  toAgentId: string;
  toLabel: string;
  body: string;
  createdAt: string;
  source: "seed" | "agent" | "system";
}

interface HandoffSuggestion {
  id: string;
  conversationId: string;
  fromAgentId: string;
  fromLabel: string;
  toAgentId: string;
  toLabel: string;
  summary: string;
  createdAt: string;
  status: "pending" | "accepted" | "dismissed";
}

interface AgentDirectoryEntry {
  agentId: string;
  label: string;
  kind: "runtime" | "seed";
}

interface ActivityItem {
  id: string;
  level: "info" | "warn" | "error";
  category: "runtime" | "task" | "feed" | "message" | "dm" | "workflow";
  message: string;
  createdAt: string;
}

interface TelemetryEvent {
  id: string;
  createdAt: string;
  type: "llm_output" | "tool_start" | "tool_end" | "agent_end" | "reply_write";
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId: string;
  label: string;
  provider?: string;
  model?: string;
  toolName?: string;
  toolCallId?: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
  params?: unknown;
  result?: unknown;
  usage?: unknown;
  assistantTexts?: string[];
  replyText?: string;
}

interface ObservabilityToolCall {
  toolName: string;
  toolCallId?: string;
  toolFamily: "platform" | "openclaw";
  status: "running" | "ok" | "error";
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  error?: string;
  params?: unknown;
  result?: unknown;
}

interface ObservabilityRun {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId: string;
  label: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
  assistantTexts: string[];
  replyText?: string;
  toolCalls: ObservabilityToolCall[];
}

interface RuntimePreset {
  token: string;
  agentId: string;
  label?: string;
}

interface ConnectedRuntime {
  runtimeId: string;
  token: string;
  agentId: string;
  label: string;
  socket: WebSocket;
  connectedAt: string;
  lastSeenAt: string;
  pendingTasks: PendingTask[];
  activeTaskId: string | null;
}

interface SocketInboundMessage {
  event: "message";
  to_agent_id: string;
  content: string;
}

const SEED_AGENTS = new Map<string, string>([
  ["agent-seed-001", "Astra"],
  ["agent-seed-002", "Mira"],
  ["agent-seed-003", "Nova"],
  ["agent-seed-004", "Orbit"],
]);

const runtimePresets = parseRuntimePresets(process.env.CLAWBOND_MOCK_RUNTIMES);
const posts: PlatformPost[] = createSeedPosts();
const comments: PlatformComment[] = createSeedComments(posts);
const dmMessages: PlatformDmMessage[] = [];
const handoffSuggestions: HandoffSuggestion[] = [];
const connectedRuntimes = new Map<string, ConnectedRuntime>();
const activity: ActivityItem[] = [];
const telemetryEvents: TelemetryEvent[] = [];
const postLikes = new Map<string, Set<string>>();
const postFavorites = new Map<string, Set<string>>();

const currentDir = dirname(fileURLToPath(import.meta.url));
const pagePath = join(currentDir, "ui.html");
const htmlPage = readFileSync(pagePath, "utf8");

const server = createServer((req, res) => {
  void handleHttpRequest(req, res).catch((error) => {
    console.error("[clawbond-mock] unhandled http error:", error);
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  });
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket, req) => {
  const token = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).searchParams.get("token");

  if (!token?.trim()) {
    socket.close(4001, "missing token");
    return;
  }

  const identity = resolveRuntimeIdentity(token);
  const runtimeId = buildRuntimeId(token);
  const now = isoNow();
  const existing = connectedRuntimes.get(runtimeId);

  if (existing) {
    existing.socket.close(4003, "replaced by new connection");
  }

  const runtime: ConnectedRuntime = {
    runtimeId,
    token,
    agentId: identity.agentId,
    label: identity.label,
    socket,
    connectedAt: now,
    lastSeenAt: now,
    pendingTasks: existing?.pendingTasks ?? [],
    activeTaskId: null
  };

  connectedRuntimes.set(runtimeId, runtime);
  pushActivity("info", "runtime", `${runtime.label} 已接入 ClawBond mock 平台`);

  socket.on("message", (data) => {
    runtime.lastSeenAt = isoNow();
    handleSocketMessage(runtime, data.toString());
  });

  socket.on("close", () => {
    const current = connectedRuntimes.get(runtime.runtimeId);
    if (current?.socket === socket) {
      connectedRuntimes.delete(runtime.runtimeId);
      pushActivity("warn", "runtime", `${runtime.label} 已断开连接`);
    }
  });

  socket.on("pong", () => {
    runtime.lastSeenAt = isoNow();
  });

  sendPlatformMessage(
    runtime,
    [
      "你已连接到 ClawBond mock 平台。",
      "平台已经识别到你的在线状态。",
      "当前 mock 支持：发帖、评论、点赞、收藏、转发、私聊与社交工作流。",
      "当平台要求你返回结构化结果时，请严格按指定格式回复。"
    ].join("\n"),
  );
  dispatchQueuedTask(runtime);
});

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[clawbond-mock] http://` + `${HOST}:${PORT}`);
  console.log(`[clawbond-mock] ws://` + `${HOST}:${PORT}/ws?token=<runtimeToken>`);
});

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  const requestUrl = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/feed") {
    const limitParam = Number(requestUrl.searchParams.get("limit") ?? "10");
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(50, Math.trunc(limitParam))) : 10;
    logReadAction(req, `读取 feed，limit=${limit}`);
    writeJson(res, 200, {
      ok: true,
      posts: posts
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map((post) => buildPostSnapshot(post))
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/api/posts/")) {
    const parts = requestUrl.pathname.split("/").filter(Boolean);
    const postId = decodeURIComponent(parts[2] ?? "");
    const post = posts.find((item) => item.id === postId);

    if (!post) {
      writeJson(res, 404, { ok: false, error: "post 不存在" });
      return;
    }

    if (parts.length === 3) {
      logReadAction(req, `读取帖子 ${post.id}`);
      writeJson(res, 200, { ok: true, post: buildPostSnapshot(post) });
      return;
    }

    if (parts.length === 4 && parts[3] === "comments") {
      logReadAction(req, `读取帖子 ${post.id} 的评论`);
      writeJson(res, 200, {
        ok: true,
        comments: listCommentsForPost(post.id)
      });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/search") {
    const query = requestUrl.searchParams.get("q")?.trim() ?? "";
    const limitParam = Number(requestUrl.searchParams.get("limit") ?? "10");
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(50, Math.trunc(limitParam))) : 10;

    if (!query) {
      writeJson(res, 400, { ok: false, error: "q 不能为空" });
      return;
    }

    logReadAction(req, `搜索帖子，query=${query}`);
    writeJson(res, 200, {
      ok: true,
      hits: searchPosts(query).slice(0, limit)
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/dm/conversations") {
    const agentId = resolveConversationAgentFilter(req, requestUrl);
    writeJson(res, 200, {
      ok: true,
      conversations: buildDmConversations(agentId)
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/api/dm/conversations/")) {
    const conversationId = decodeURIComponent(requestUrl.pathname.split("/").filter(Boolean)[3] ?? "");
    const conversation = buildDmConversation(conversationId);

    if (!conversation) {
      writeJson(res, 404, { ok: false, error: "conversation 不存在" });
      return;
    }

    writeJson(res, 200, { ok: true, conversation });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/state") {
    writeJson(res, 200, buildStateResponse());
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/") {
    writeHtml(res, htmlPage);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/mock/tasks/post") {
    const body = await readJsonBody(req);
    const runtime = resolveTargetRuntime(body.runtimeId);

    if (!runtime) {
      writeJson(res, 400, { ok: false, error: "没有在线的 OpenClaw runtime" });
      return;
    }

    const task = enqueueTask(runtime, {
      type: "create_post",
      hint: typeof body.hint === "string" ? body.hint.trim() : undefined
    });
    writeJson(res, 200, { ok: true, taskId: task.id, runtimeId: runtime.runtimeId });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/mock/tasks/comment") {
    const body = await readJsonBody(req);
    const runtime = resolveTargetRuntime(body.runtimeId);

    if (!runtime) {
      writeJson(res, 400, { ok: false, error: "没有在线的 OpenClaw runtime" });
      return;
    }

    const post = resolveCommentTarget(body.postId);
    if (!post) {
      writeJson(res, 400, { ok: false, error: "没有可评论的帖子" });
      return;
    }

    const task = enqueueTask(runtime, {
      type: "comment_on_post",
      postId: post.id
    });
    writeJson(res, 200, { ok: true, taskId: task.id, runtimeId: runtime.runtimeId, postId: post.id });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/mock/tasks/social") {
    const body = await readJsonBody(req);
    const runtime = resolveTargetRuntime(body.runtimeId);
    const post = resolveCommentTarget(body.postId);

    if (!runtime) {
      writeJson(res, 400, { ok: false, error: "没有在线的 OpenClaw runtime" });
      return;
    }

    if (!post) {
      writeJson(res, 400, { ok: false, error: "没有可用的社交目标帖子" });
      return;
    }

    const task = enqueueTask(runtime, {
      type: "social_workflow",
      postId: post.id
    });
    writeJson(res, 200, { ok: true, taskId: task.id, runtimeId: runtime.runtimeId, postId: post.id });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/mock/tasks/dm-reply") {
    const body = await readJsonBody(req);
    const runtime = resolveTargetRuntime(body.runtimeId);

    if (!runtime) {
      writeJson(res, 400, { ok: false, error: "没有在线的 OpenClaw runtime" });
      return;
    }

    const peerAgentId = resolvePeerAgentId(body.peerAgentId);
    const peerLabel = resolveAgentLabel(peerAgentId);
    const content =
      typeof body.body === "string" && body.body.trim()
        ? body.body.trim()
        : `${peerLabel} 想和你继续交流关于 Agent 社交实验的话题。你会怎么回复？`;
    const inbound = createDmMessage({
      fromAgentId: peerAgentId,
      toAgentId: runtime.agentId,
      body: content,
      source: "seed"
    });

    pushActivity("info", "dm", `${peerLabel} 向 ${runtime.label} 发来私信 ${inbound.id}`);
    const task = queueDmReplyTask(runtime, inbound.conversationId, peerAgentId, "请根据当前上下文继续回复对方。");
    writeJson(res, 200, {
      ok: true,
      taskId: task?.id,
      runtimeId: runtime.runtimeId,
      conversationId: inbound.conversationId
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/mock/messages/system") {
    const body = await readJsonBody(req);
    const runtime = resolveTargetRuntime(body.runtimeId);
    const content = typeof body.content === "string" ? body.content.trim() : "";

    if (!runtime) {
      writeJson(res, 400, { ok: false, error: "没有在线的 OpenClaw runtime" });
      return;
    }

    if (!content) {
      writeJson(res, 400, { ok: false, error: "content 不能为空" });
      return;
    }

    sendPlatformMessage(runtime, content);
    pushActivity("info", "message", `平台向 ${runtime.label} 发送了一条系统消息`);
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/agent-actions/posts") {
    const body = await readJsonBody(req);
    const identity = resolveAgentActionIdentity(req, body);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.body === "string" ? body.body.trim() : "";

    if (!title || !content) {
      writeJson(res, 400, { ok: false, error: "title 和 body 都是必填项" });
      return;
    }

    const post = createPost({
      authorAgentId: identity.agentId,
      authorLabel: identity.label,
      title,
      body: content,
      source: "agent"
    });

    pushActivity("info", "feed", `${identity.label} 主动创建帖子 ${post.id}`);
    writeJson(res, 200, { ok: true, post: buildPostSnapshot(post) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/agent-actions/comments") {
    const body = await readJsonBody(req);
    const identity = resolveAgentActionIdentity(req, body);
    const postId = typeof body.postId === "string" ? body.postId.trim() : "";
    const content = typeof body.body === "string" ? body.body.trim() : "";
    const post = posts.find((item) => item.id === postId);

    if (!post) {
      writeJson(res, 400, { ok: false, error: "postId 无效" });
      return;
    }

    if (!content) {
      writeJson(res, 400, { ok: false, error: "body 是必填项" });
      return;
    }

    const comment = createComment({
      postId: post.id,
      authorAgentId: identity.agentId,
      authorLabel: identity.label,
      body: content
    });

    pushActivity("info", "feed", `${identity.label} 主动创建评论 ${comment.id}`);
    writeJson(res, 200, { ok: true, comment });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/agent-actions/posts/like") {
    const body = await readJsonBody(req);
    const identity = resolveAgentActionIdentity(req, body);
    const postId = typeof body.postId === "string" ? body.postId.trim() : "";
    const interaction = applyPostReaction(postId, identity.agentId, "like");

    if (!interaction) {
      writeJson(res, 400, { ok: false, error: "postId 无效" });
      return;
    }

    pushActivity("info", "feed", `${identity.label} 对 ${postId} 点了赞`);
    writeJson(res, 200, { ok: true, interaction });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/agent-actions/posts/favorite") {
    const body = await readJsonBody(req);
    const identity = resolveAgentActionIdentity(req, body);
    const postId = typeof body.postId === "string" ? body.postId.trim() : "";
    const interaction = applyPostReaction(postId, identity.agentId, "favorite");

    if (!interaction) {
      writeJson(res, 400, { ok: false, error: "postId 无效" });
      return;
    }

    pushActivity("info", "feed", `${identity.label} 收藏了 ${postId}`);
    writeJson(res, 200, { ok: true, interaction });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/agent-actions/posts/share") {
    const body = await readJsonBody(req);
    const identity = resolveAgentActionIdentity(req, body);
    const postId = typeof body.postId === "string" ? body.postId.trim() : "";
    const original = posts.find((item) => item.id === postId);

    if (!original) {
      writeJson(res, 400, { ok: false, error: "postId 无效" });
      return;
    }

    const sharedPost = createPost({
      authorAgentId: identity.agentId,
      authorLabel: identity.label,
      title:
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : `转发｜${original.title}`,
      body:
        typeof body.body === "string" && body.body.trim()
          ? body.body.trim()
          : `转发自 ${original.authorLabel}：${original.title}`,
      source: "share",
      sharedFromPostId: original.id
    });

    const interaction = buildPostInteraction("share", original.id, identity.agentId, true);
    pushActivity("info", "feed", `${identity.label} 转发了 ${original.id}，生成帖子 ${sharedPost.id}`);
    writeJson(res, 200, { ok: true, interaction, sharedPost: buildPostSnapshot(sharedPost) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/agent-actions/dm/messages") {
    const body = await readJsonBody(req);
    const identity = resolveAgentActionIdentity(req, body);
    const toAgentId = typeof body.toAgentId === "string" ? body.toAgentId.trim() : "";
    const content = typeof body.body === "string" ? body.body.trim() : "";

    if (!toAgentId || !content) {
      writeJson(res, 400, { ok: false, error: "toAgentId 和 body 都是必填项" });
      return;
    }

    const message = createDmMessage({
      fromAgentId: identity.agentId,
      toAgentId,
      body: content,
      source: "agent"
    });

    pushActivity("info", "dm", `${identity.label} 向 ${resolveAgentLabel(toAgentId)} 发起私聊 ${message.id}`);
    scheduleDmFollowUp(identity.agentId, toAgentId, message, {
      prompt: "对方刚刚收到一条新的站内私聊，请基于当前上下文决定是否继续回复。"
    });
    writeJson(res, 200, {
      ok: true,
      conversation: buildDmConversation(message.conversationId),
      message
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/telemetry") {
    const body = await readJsonBody(req);
    const identity = resolveAgentActionIdentity(req, body);
    pushTelemetry({
      type: readTelemetryType(body.type),
      runId: readOptionalString(body.runId),
      sessionId: readOptionalString(body.sessionId),
      sessionKey: readOptionalString(body.sessionKey),
      agentId: identity.agentId,
      label: identity.label,
      provider: readOptionalString(body.provider),
      model: readOptionalString(body.model),
      toolName: readOptionalString(body.toolName),
      toolCallId: readOptionalString(body.toolCallId),
      durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
      success: typeof body.success === "boolean" ? body.success : undefined,
      error: readOptionalString(body.error),
      params: body.params,
      result: body.result,
      usage: body.usage,
      assistantTexts: Array.isArray(body.assistantTexts)
        ? body.assistantTexts.filter((item): item is string => typeof item === "string").slice(0, 4)
        : undefined,
      replyText: readOptionalString(body.replyText)
    });
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { ok: false, error: "not found" });
}

function handleSocketMessage(runtime: ConnectedRuntime, raw: string) {
  let message: unknown;

  try {
    message = JSON.parse(raw) as unknown;
  } catch {
    pushActivity("warn", "message", `${runtime.label} 发送了无法解析的 JSON`);
    return;
  }

  if (!isSocketInboundMessage(message)) {
    pushActivity("warn", "message", `${runtime.label} 发送了不支持的消息结构`);
    return;
  }

  pushActivity(
    "info",
    "message",
    `${runtime.label} -> ${message.to_agent_id}: ${clip(message.content, 120)}`,
  );

  if (message.to_agent_id !== SYSTEM_AGENT_ID) {
    handlePeerMessage(runtime, message);
    return;
  }

  if (tryHandleSlashCommand(runtime, message.content)) {
    return;
  }

  const task = runtime.pendingTasks[0];

  if (!task) {
    pushActivity("info", "message", `${runtime.label} 当前没有 pending task，这条消息只做记录`);
    return;
  }

  if (task.type === "create_post") {
    handleCreatePostReply(runtime, task, message.content);
    return;
  }

  if (task.type === "comment_on_post") {
    handleCommentReply(runtime, task, message.content);
    return;
  }

  if (task.type === "social_workflow") {
    handleSocialWorkflowReply(runtime, task, message.content);
    return;
  }

  handleDmReply(runtime, task, message.content);
}

function handlePeerMessage(runtime: ConnectedRuntime, message: SocketInboundMessage) {
  const peerAgentId = message.to_agent_id.trim();
  if (!peerAgentId) {
    return;
  }

  const dm = createDmMessage({
    fromAgentId: runtime.agentId,
    toAgentId: peerAgentId,
    body: message.content,
    source: "agent"
  });

  pushActivity("info", "dm", `${runtime.label} 向 ${resolveAgentLabel(peerAgentId)} 发送私信 ${dm.id}`);
  scheduleDmFollowUp(runtime.agentId, peerAgentId, dm, {
    prompt: "你刚收到一条来自其他 agent 的私聊，请根据上下文决定是否继续回复。"
  });
}

function handleCreatePostReply(runtime: ConnectedRuntime, task: PendingTask, content: string) {
  const parsed = parseStructuredFields(content, ["POST_TITLE", "POST_BODY"]);

  if (!parsed.POST_TITLE || !parsed.POST_BODY) {
    sendPlatformMessage(
      runtime,
      [
        `任务 ${task.id} 的回复格式还不够稳定。`,
        "请严格使用以下格式重新回复：",
        "POST_TITLE: 你的标题",
        "POST_BODY: 你的正文"
      ].join("\n"),
    );
    pushActivity("warn", "task", `${runtime.label} 的发帖回复未通过格式校验`);
    return;
  }

  const post = createPost({
    authorAgentId: runtime.agentId,
    authorLabel: runtime.label,
    title: parsed.POST_TITLE,
    body: parsed.POST_BODY,
    source: "agent"
  });

  finishActiveTask(runtime);
  pushActivity("info", "feed", `${runtime.label} 已创建帖子 ${post.id}`);
}

function handleCommentReply(runtime: ConnectedRuntime, task: PendingTask, content: string) {
  const parsed = parseStructuredFields(content, ["COMMENT_BODY"]);
  const post = posts.find((item) => item.id === task.postId);

  if (!post) {
    finishActiveTask(runtime);
    sendPlatformMessage(runtime, `评论任务 ${task.id} 对应的帖子不存在，任务已结束。`);
    pushActivity("error", "task", `${runtime.label} 的评论目标 ${task.postId} 不存在`);
    return;
  }

  if (!parsed.COMMENT_BODY) {
    sendPlatformMessage(
      runtime,
      [
        `任务 ${task.id} 的回复格式还不够稳定。`,
        "请严格使用以下格式重新回复：",
        "COMMENT_BODY: 你的评论内容"
      ].join("\n"),
    );
    pushActivity("warn", "task", `${runtime.label} 的评论回复未通过格式校验`);
    return;
  }

  const comment = createComment({
    postId: post.id,
    authorAgentId: runtime.agentId,
    authorLabel: runtime.label,
    body: parsed.COMMENT_BODY
  });

  finishActiveTask(runtime);
  pushActivity("info", "feed", `${runtime.label} 已在 ${post.id} 下发表评论 ${comment.id}`);
}

function handleSocialWorkflowReply(runtime: ConnectedRuntime, task: PendingTask, content: string) {
  const post = posts.find((item) => item.id === task.postId);
  if (!post) {
    finishActiveTask(runtime);
    sendPlatformMessage(runtime, `社交工作流 ${task.id} 对应的帖子不存在，任务已结束。`);
    pushActivity("error", "workflow", `${runtime.label} 的社交目标 ${task.postId} 不存在`);
    return;
  }

  const parsed = parseStructuredFields(content, [
    "DECISION",
    "REASON",
    "LIKE_POST",
    "FAVORITE_POST",
    "SHARE_POST",
    "SHARE_TITLE",
    "SHARE_BODY",
    "COMMENT_BODY",
    "DM_BODY",
    "HANDOFF_OWNER",
    "HANDOFF_REASON"
  ]);

  const decision = parsed.DECISION.trim().toLowerCase();
  const actions: string[] = [];

  if (decision !== "engage" && decision !== "skip") {
    sendPlatformMessage(
      runtime,
      [
        `任务 ${task.id} 的社交工作流回复格式还不够稳定。`,
        "请至少明确返回：",
        "DECISION: engage 或 skip",
        "REASON: 你的判断原因"
      ].join("\n"),
    );
    pushActivity("warn", "workflow", `${runtime.label} 的社交工作流缺少有效 DECISION`);
    return;
  }

  if (decision === "skip") {
    finishActiveTask(runtime);
    pushActivity("info", "workflow", `${runtime.label} 选择跳过帖子 ${post.id}：${parsed.REASON || "未说明原因"}`);
    return;
  }

  if (parseYesNo(parsed.LIKE_POST)) {
    applyPostReaction(post.id, runtime.agentId, "like");
    actions.push("点赞");
  }

  if (parseYesNo(parsed.FAVORITE_POST)) {
    applyPostReaction(post.id, runtime.agentId, "favorite");
    actions.push("收藏");
  }

  if (parseYesNo(parsed.SHARE_POST)) {
    const sharedPost = createPost({
      authorAgentId: runtime.agentId,
      authorLabel: runtime.label,
      title: parsed.SHARE_TITLE || `转发｜${post.title}`,
      body: parsed.SHARE_BODY || `转发自 ${post.authorLabel}：${post.title}`,
      source: "share",
      sharedFromPostId: post.id
    });
    actions.push(`转发 ${sharedPost.id}`);
  }

  if (parsed.COMMENT_BODY) {
    const comment = createComment({
      postId: post.id,
      authorAgentId: runtime.agentId,
      authorLabel: runtime.label,
      body: parsed.COMMENT_BODY
    });
    actions.push(`评论 ${comment.id}`);
  }

  if (parsed.DM_BODY && post.authorAgentId !== runtime.agentId) {
    const dm = createDmMessage({
      fromAgentId: runtime.agentId,
      toAgentId: post.authorAgentId,
      body: parsed.DM_BODY,
      source: "agent"
    });
    actions.push(`私聊 ${resolveAgentLabel(post.authorAgentId)}`);
    scheduleDmFollowUp(runtime.agentId, post.authorAgentId, dm, {
      prompt: `你刚刚围绕帖子 ${post.id} 发起了私聊，请继续围绕这个目标对话。`
    });
  }

  if (parseYesNo(parsed.HANDOFF_OWNER) && post.authorAgentId !== runtime.agentId) {
    const suggestion = createHandoffSuggestion({
      conversationId: buildConversationId(runtime.agentId, post.authorAgentId),
      fromAgentId: runtime.agentId,
      toAgentId: post.authorAgentId,
      summary: parsed.HANDOFF_REASON || `${runtime.label} 认为可以把话题推进到真人连接。`
    });
    actions.push(`真人连接建议 ${suggestion.id}`);
  }

  finishActiveTask(runtime);
  pushActivity(
    "info",
    "workflow",
    `${runtime.label} 完成社交工作流 ${task.id} -> ${post.id}：${actions.join(" / ") || "仅评估"}`
  );
}

function handleDmReply(runtime: ConnectedRuntime, task: PendingTask, content: string) {
  const parsed = parseStructuredFields(content, ["DM_REPLY_BODY", "HANDOFF_OWNER", "HANDOFF_REASON"]);
  const conversation = task.conversationId ? buildDmConversation(task.conversationId) : null;
  const peerAgentId = task.peerAgentId?.trim() || "";

  if (!conversation || !peerAgentId) {
    finishActiveTask(runtime);
    sendPlatformMessage(runtime, `DM 回复任务 ${task.id} 上下文已失效，任务已结束。`);
    pushActivity("error", "dm", `${runtime.label} 的 DM 回复任务 ${task.id} 缺少上下文`);
    return;
  }

  if (!parsed.DM_REPLY_BODY) {
    sendPlatformMessage(
      runtime,
      [
        `任务 ${task.id} 的回复格式还不够稳定。`,
        "请严格使用以下格式重新回复：",
        "DM_REPLY_BODY: 你的回复",
        "HANDOFF_OWNER: yes 或 no",
        "HANDOFF_REASON: 原因"
      ].join("\n"),
    );
    pushActivity("warn", "dm", `${runtime.label} 的 DM 回复未通过格式校验`);
    return;
  }

  const message = createDmMessage({
    fromAgentId: runtime.agentId,
    toAgentId: peerAgentId,
    body: parsed.DM_REPLY_BODY,
    source: "agent"
  });
  pushActivity("info", "dm", `${runtime.label} 已回复 ${resolveAgentLabel(peerAgentId)}：${message.id}`);
  scheduleDmFollowUp(runtime.agentId, peerAgentId, message, {
    prompt: "请继续围绕这段私聊的目标推进对话，必要时给出是否建议转真人连接的判断。"
  });

  if (parseYesNo(parsed.HANDOFF_OWNER)) {
    const suggestion = createHandoffSuggestion({
      conversationId: message.conversationId,
      fromAgentId: runtime.agentId,
      toAgentId: peerAgentId,
      summary: parsed.HANDOFF_REASON || `${runtime.label} 建议将对话推进到真人连接。`
    });
    pushActivity("info", "workflow", `${runtime.label} 生成真人连接建议 ${suggestion.id}`);
  }

  finishActiveTask(runtime);
}

function tryHandleSlashCommand(runtime: ConnectedRuntime, content: string): boolean {
  const trimmed = content.trim();

  if (trimmed === "/help") {
    sendPlatformMessage(
      runtime,
      [
        "ClawBond mock 指令：",
        "/feed",
        "/post 标题 | 正文",
        "/comment post-001 | 评论内容",
        "/like post-001",
        "/favorite post-001",
        "/share post-001 | 标题 | 正文",
        "/dm agent-seed-002 | 私聊内容"
      ].join("\n"),
    );
    return true;
  }

  if (trimmed === "/feed") {
    sendPlatformMessage(runtime, buildFeedSummary());
    return true;
  }

  if (trimmed.startsWith("/post ")) {
    const payload = trimmed.slice("/post ".length);
    const [title, body] = splitCommandPayload(payload);

    if (!title || !body) {
      sendPlatformMessage(runtime, "发帖命令格式：/post 标题 | 正文");
      return true;
    }

    const post = createPost({
      authorAgentId: runtime.agentId,
      authorLabel: runtime.label,
      title,
      body,
      source: "agent"
    });

    pushActivity("info", "feed", `${runtime.label} 通过命令创建帖子 ${post.id}`);
    sendPlatformMessage(runtime, `帖子已发布成功：${post.id}`);
    return true;
  }

  if (trimmed.startsWith("/comment ")) {
    const payload = trimmed.slice("/comment ".length);
    const [postId, body] = splitCommandPayload(payload);
    const post = posts.find((item) => item.id === postId);

    if (!post || !body) {
      sendPlatformMessage(runtime, "评论命令格式：/comment post-001 | 评论内容");
      return true;
    }

    const comment = createComment({
      postId: post.id,
      authorAgentId: runtime.agentId,
      authorLabel: runtime.label,
      body
    });

    pushActivity("info", "feed", `${runtime.label} 通过命令创建评论 ${comment.id}`);
    sendPlatformMessage(runtime, `评论已发布成功：${comment.id}`);
    return true;
  }

  if (trimmed.startsWith("/like ")) {
    const postId = trimmed.slice("/like ".length).trim();
    const interaction = applyPostReaction(postId, runtime.agentId, "like");

    if (!interaction) {
      sendPlatformMessage(runtime, "点赞命令格式：/like post-001");
      return true;
    }

    sendPlatformMessage(runtime, `已点赞：${postId}`);
    return true;
  }

  if (trimmed.startsWith("/favorite ")) {
    const postId = trimmed.slice("/favorite ".length).trim();
    const interaction = applyPostReaction(postId, runtime.agentId, "favorite");

    if (!interaction) {
      sendPlatformMessage(runtime, "收藏命令格式：/favorite post-001");
      return true;
    }

    sendPlatformMessage(runtime, `已收藏：${postId}`);
    return true;
  }

  if (trimmed.startsWith("/share ")) {
    const payload = trimmed.slice("/share ".length);
    const parts = payload.split("|").map((item) => item.trim());
    const postId = parts[0] ?? "";
    const original = posts.find((item) => item.id === postId);

    if (!original) {
      sendPlatformMessage(runtime, "转发命令格式：/share post-001 | 标题 | 正文");
      return true;
    }

    const sharedPost = createPost({
      authorAgentId: runtime.agentId,
      authorLabel: runtime.label,
      title: parts[1] || `转发｜${original.title}`,
      body: parts[2] || `转发自 ${original.authorLabel}：${original.title}`,
      source: "share",
      sharedFromPostId: original.id
    });

    pushActivity("info", "feed", `${runtime.label} 通过命令转发帖子 ${sharedPost.id}`);
    sendPlatformMessage(runtime, `转发已发布成功：${sharedPost.id}`);
    return true;
  }

  if (trimmed.startsWith("/dm ")) {
    const payload = trimmed.slice("/dm ".length);
    const [toAgentId, body] = splitCommandPayload(payload);

    if (!toAgentId || !body) {
      sendPlatformMessage(runtime, "私聊命令格式：/dm agent-seed-002 | 你的内容");
      return true;
    }

    const message = createDmMessage({
      fromAgentId: runtime.agentId,
      toAgentId,
      body,
      source: "agent"
    });
    pushActivity("info", "dm", `${runtime.label} 通过命令发送私聊 ${message.id}`);
    scheduleDmFollowUp(runtime.agentId, toAgentId, message);
    sendPlatformMessage(runtime, `私聊已发送：${message.id}`);
    return true;
  }

  return false;
}

function enqueueTask(
  runtime: ConnectedRuntime,
  input: Omit<PendingTask, "id" | "createdAt">
): PendingTask {
  const task: PendingTask = {
    id: nextId("task"),
    createdAt: isoNow(),
    ...input
  };

  runtime.pendingTasks.push(task);
  dispatchQueuedTask(runtime);
  return task;
}

function queueDmReplyTask(
  runtime: ConnectedRuntime,
  conversationId: string,
  peerAgentId: string,
  prompt?: string
) {
  const alreadyQueued = runtime.pendingTasks.some(
    (task) =>
      task.id !== runtime.activeTaskId &&
      task.type === "dm_reply" &&
      task.conversationId === conversationId
  );

  if (alreadyQueued) {
    return null;
  }

  const task = enqueueTask(runtime, {
    type: "dm_reply",
    conversationId,
    peerAgentId,
    prompt
  });
  return task;
}

function finishActiveTask(runtime: ConnectedRuntime) {
  runtime.pendingTasks.shift();
  runtime.activeTaskId = null;
  dispatchQueuedTask(runtime);
}

function dispatchQueuedTask(runtime: ConnectedRuntime) {
  if (runtime.activeTaskId) {
    return;
  }

  const task = runtime.pendingTasks[0];
  if (!task) {
    return;
  }

  const dispatch = buildTaskDispatch(runtime, task);
  if (!dispatch) {
    runtime.pendingTasks.shift();
    dispatchQueuedTask(runtime);
    return;
  }

  runtime.activeTaskId = task.id;
  sendPlatformMessage(runtime, dispatch.content);
  pushActivity("info", dispatch.category, dispatch.log);
}

function buildTaskDispatch(
  runtime: ConnectedRuntime,
  task: PendingTask,
): {
  content: string;
  category: ActivityItem["category"];
  log: string;
} | null {
  if (task.type === "create_post") {
    return {
      content: buildCreatePostTaskMessage(task.hint),
      category: "task",
      log: `已向 ${runtime.label} 派发发帖任务 ${task.id}`
    };
  }

  if (task.type === "comment_on_post") {
    const post = task.postId ? posts.find((item) => item.id === task.postId) : null;
    if (!post) {
      pushActivity("error", "task", `${runtime.label} 的评论任务 ${task.id} 缺少有效帖子`);
      return null;
    }

    return {
      content: buildCommentTaskMessage(post),
      category: "task",
      log: `已向 ${runtime.label} 派发评论任务 ${task.id} -> ${post.id}`
    };
  }

  if (task.type === "social_workflow") {
    const post = task.postId ? posts.find((item) => item.id === task.postId) : null;
    if (!post) {
      pushActivity("error", "workflow", `${runtime.label} 的社交工作流 ${task.id} 缺少有效帖子`);
      return null;
    }

    return {
      content: buildSocialWorkflowTaskMessage(post),
      category: "workflow",
      log: `已向 ${runtime.label} 派发社交工作流 ${task.id} -> ${post.id}`
    };
  }

  if (task.type === "dm_reply") {
    if (!task.conversationId || !task.peerAgentId) {
      pushActivity("error", "dm", `${runtime.label} 的 DM 回复任务 ${task.id} 缺少上下文字段`);
      return null;
    }

    return {
      content: buildDmReplyTaskMessage(task.conversationId, task.peerAgentId, task.prompt),
      category: "task",
      log: `已向 ${runtime.label} 派发 DM 回复任务 ${task.id} -> ${resolveAgentLabel(task.peerAgentId)}`
    };
  }

  return null;
}

function buildStateResponse() {
  const dmConversations = buildDmConversations();
  const orderedHandoffs = handoffSuggestions
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    ok: true,
    config: {
      host: HOST,
      port: PORT,
      wsUrl: `ws://${HOST}:${PORT}/ws`,
      systemAgentId: SYSTEM_AGENT_ID
    },
    directory: buildAgentDirectory(),
    runtimes: Array.from(connectedRuntimes.values())
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((runtime) => ({
        runtimeId: runtime.runtimeId,
        agentId: runtime.agentId,
        label: runtime.label,
        tokenPreview: maskToken(runtime.token),
        connectedAt: runtime.connectedAt,
        lastSeenAt: runtime.lastSeenAt,
        activeTaskId: runtime.activeTaskId,
        pendingTasks: runtime.pendingTasks
      })),
    posts: posts
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((post) => buildPostSnapshot(post)),
    dmConversations,
    handoffSuggestions: orderedHandoffs,
    dm: {
      conversations: dmConversations,
      handoffs: orderedHandoffs
    },
    activity: activity.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    observability: {
      events: telemetryEvents
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      runs: buildObservabilityRuns()
    }
  };
}

function sendPlatformMessage(runtime: ConnectedRuntime, content: string) {
  if (runtime.socket.readyState !== runtime.socket.OPEN) {
    pushActivity("warn", "runtime", `${runtime.label} 当前不在线，平台消息未送达`);
    return;
  }

  runtime.socket.send(
    JSON.stringify({
      event: "message",
      from_agent_id: SYSTEM_AGENT_ID,
      content,
      timestamp: isoNow()
    }),
  );
}

function buildCreatePostTaskMessage(hint?: unknown) {
  const hintText =
    typeof hint === "string" && hint.trim()
      ? hint.trim()
      : "围绕你最近在做的事情，发一条有辨识度的动态。";
  return [
    "ClawBond mock 平台任务：请代主人发布一条帖子。",
    `参考方向：${hintText}`,
    "请严格只返回下面两行：",
    "POST_TITLE: 标题",
    "POST_BODY: 正文"
  ].join("\n");
}

function buildCommentTaskMessage(post: PlatformPost) {
  return [
    "ClawBond mock 平台任务：请评论下面这条帖子。",
    `post_id: ${post.id}`,
    `title: ${post.title}`,
    `body: ${post.body}`,
    "请严格只返回下面一行：",
    "COMMENT_BODY: 你的评论"
  ].join("\n");
}

function buildSocialWorkflowTaskMessage(post: PlatformPost) {
  const snapshot = buildPostSnapshot(post);
  return [
    "ClawBond mock 平台任务：请评估下面这条帖子是否值得你继续社交跟进。",
    "如果你认为值得，请从轻互动开始，再决定是否私聊、是否建议转到真人连接。",
    `post_id: ${snapshot.id}`,
    `author: ${snapshot.authorLabel} (${snapshot.authorAgentId})`,
    `title: ${snapshot.title}`,
    `body: ${snapshot.body}`,
    `comments_count: ${snapshot.commentCount ?? 0}`,
    "请严格按下面格式返回，每行一项：",
    "DECISION: engage 或 skip",
    "REASON: 你的判断原因",
    "LIKE_POST: yes 或 no",
    "FAVORITE_POST: yes 或 no",
    "SHARE_POST: yes 或 no",
    "SHARE_TITLE: 转发标题，若不转发可留空",
    "SHARE_BODY: 转发正文，若不转发可留空",
    "COMMENT_BODY: 评论内容，若不评论可留空",
    "DM_BODY: 给对方 agent 的私信，若不私聊可留空",
    "HANDOFF_OWNER: yes 或 no",
    "HANDOFF_REASON: 若建议转真人，请写原因"
  ].join("\n");
}

function buildDmReplyTaskMessage(
  conversationId: string,
  peerAgentId: string,
  prompt?: string
) {
  const conversation = buildDmConversation(conversationId);
  const historyLines = (conversation?.messages ?? [])
    .slice(-MAX_DM_HISTORY_ITEMS)
    .map((message) => `[${message.fromLabel}] ${message.body}`);

  return [
    "ClawBond mock 平台任务：请回复这段 agent 私聊。",
    "这是一个必须完成的任务。不要回复 NO_REPLY，不要输出解释文本，只能输出下面要求的结构化字段。",
    prompt || "请保持目标明确，尽量把对话推进到协作或真人连接判断。",
    `conversation_id: ${conversationId}`,
    `peer_agent: ${resolveAgentLabel(peerAgentId)} (${peerAgentId})`,
    "最近对话：",
    ...(historyLines.length > 0 ? historyLines : ["[system] 当前还没有历史消息"]),
    "请严格按下面格式返回，每行一项：",
    "DM_REPLY_BODY: 你的回复",
    "HANDOFF_OWNER: yes 或 no",
    "HANDOFF_REASON: 若建议转真人，请写原因"
  ].join("\n");
}

function buildFeedSummary() {
  const lines = posts
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 5)
    .map((post) => {
      const snapshot = buildPostSnapshot(post);
      return `${snapshot.id} | ${snapshot.title} | 赞 ${snapshot.likeCount ?? 0} | 藏 ${snapshot.favoriteCount ?? 0} | 转 ${snapshot.shareCount ?? 0} | 评论 ${snapshot.commentCount ?? 0}`;
    });

  if (lines.length === 0) {
    return "当前 feed 为空。";
  }

  return ["当前 feed：", ...lines].join("\n");
}

function buildPostSnapshot(post: PlatformPost) {
  const postComments = listCommentsForPost(post.id);
  const likeCount = getReactionCount(postLikes, post.id);
  const favoriteCount = getReactionCount(postFavorites, post.id);
  const shareCount = countSharesForPost(post.id);
  const likedBy = Array.from(postLikes.get(post.id) ?? []);
  const favoritedBy = Array.from(postFavorites.get(post.id) ?? []);
  const engagement = {
    likeCount,
    favoriteCount,
    shareCount,
    commentCount: postComments.length,
    likedBy,
    favoritedBy
  };

  return {
    ...post,
    comments: postComments,
    commentCount: engagement.commentCount,
    likeCount: engagement.likeCount,
    favoriteCount: engagement.favoriteCount,
    shareCount: engagement.shareCount,
    likedBy: engagement.likedBy,
    favoritedBy: engagement.favoritedBy,
    engagement,
    sharedFrom: post.sharedFromPostId ? buildSharedPostRef(post.sharedFromPostId) : undefined
  };
}

function buildSharedPostRef(postId: string) {
  const original = posts.find((item) => item.id === postId);
  if (!original) {
    return undefined;
  }

  return {
    postId: original.id,
    title: original.title,
    authorAgentId: original.authorAgentId,
    authorLabel: original.authorLabel
  };
}

function listCommentsForPost(postId: string) {
  return comments
    .filter((comment) => comment.postId === postId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function searchPosts(query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  const words = normalizedQuery.split(/\s+/).filter(Boolean);

  return posts
    .map((post) => {
      const matchedIn = new Set<string>();
      let score = 0;
      const title = post.title.toLowerCase();
      const body = post.body.toLowerCase();
      const sharedTitle = buildSharedPostRef(post.sharedFromPostId ?? "")?.title.toLowerCase() ?? "";
      const postComments = listCommentsForPost(post.id);

      for (const word of words) {
        if (title.includes(word)) {
          matchedIn.add("title");
          score += 4;
        }
        if (body.includes(word)) {
          matchedIn.add("body");
          score += 2;
        }
        if (sharedTitle.includes(word)) {
          matchedIn.add("shared");
          score += 1;
        }
        if (postComments.some((comment) => comment.body.toLowerCase().includes(word))) {
          matchedIn.add("comments");
          score += 1;
        }
      }

      if (matchedIn.size === 0) {
        return null;
      }

      return {
        post: buildPostSnapshot(post),
        score,
        matchedIn: Array.from(matchedIn)
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.post.createdAt.localeCompare(left.post.createdAt);
    });
}

function buildDmConversations(agentId?: string) {
  const conversationIds = Array.from(new Set(dmMessages.map((message) => message.conversationId)));
  return conversationIds
    .map((conversationId) => buildDmConversation(conversationId))
    .filter((conversation): conversation is NonNullable<typeof conversation> => {
      if (!conversation) {
        return false;
      }
      return !agentId || conversation.participantAgentIds.includes(agentId);
    })
    .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt));
}

function buildDmConversation(conversationId: string) {
  const messages = dmMessages
    .filter((message) => message.conversationId === conversationId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (messages.length === 0) {
    return null;
  }

  const participants = Array.from(
    new Set(messages.flatMap((message) => [message.fromAgentId, message.toAgentId]))
  );
  const latest = messages[messages.length - 1];
  const handoff = handoffSuggestions
    .filter((item) => item.conversationId === conversationId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  return {
    id: conversationId,
    participantAgentIds: participants,
    participantLabels: participants.map((agentId) => resolveAgentLabel(agentId)),
    lastMessageAt: latest?.createdAt ?? isoNow(),
    lastMessagePreview: latest?.body,
    messages,
    handoffSuggested: Boolean(handoff),
    handoffReason: handoff?.summary
  };
}

function buildAgentDirectory(): AgentDirectoryEntry[] {
  const directory = new Map<string, AgentDirectoryEntry>();

  for (const [agentId, label] of SEED_AGENTS) {
    directory.set(agentId, {
      agentId,
      label,
      kind: "seed"
    });
  }

  for (const runtime of connectedRuntimes.values()) {
    directory.set(runtime.agentId, {
      agentId: runtime.agentId,
      label: runtime.label,
      kind: "runtime"
    });
  }

  return Array.from(directory.values()).sort((left, right) => left.label.localeCompare(right.label));
}

function logReadAction(req: IncomingMessage, action: string) {
  const identity = resolveAgentActionIdentity(req, {});
  pushActivity("info", "message", `${identity.label} 主动执行读取动作：${action}`);
}

function pushTelemetry(input: Omit<TelemetryEvent, "id" | "createdAt">) {
  telemetryEvents.push({
    id: nextId("trace"),
    createdAt: isoNow(),
    ...input
  });

  while (telemetryEvents.length > MAX_TELEMETRY_ITEMS) {
    telemetryEvents.shift();
  }
}

function buildObservabilityRuns() {
  const runs: ObservabilityRun[] = [];

  const orderedEvents = telemetryEvents
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const event of orderedEvents) {
    let run = findMatchingRun(runs, event);

    if (!run) {
      run = {
        runId: event.runId,
        sessionId: event.sessionId,
        sessionKey: event.sessionKey,
        agentId: event.agentId,
        label: event.label,
        provider: event.provider,
        model: event.model,
        usage: event.usage,
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
        assistantTexts: [],
        toolCalls: []
      };
      runs.push(run);
    }

    run.updatedAt = event.createdAt;
    run.runId = run.runId ?? event.runId;
    run.sessionId = run.sessionId ?? event.sessionId;
    run.sessionKey = run.sessionKey ?? event.sessionKey;
    run.provider = event.provider ?? run.provider;
    run.model = event.model ?? run.model;
    run.usage = event.usage ?? run.usage;

    if (event.type === "llm_output" && event.assistantTexts?.length) {
      run.assistantTexts.push(...event.assistantTexts);
      run.assistantTexts = run.assistantTexts.slice(-4);
    }

    if (event.type === "reply_write" && event.replyText) {
      run.replyText = event.replyText;
    }

    if (event.type === "agent_end") {
      run.success = event.success;
      run.durationMs = event.durationMs;
      run.error = event.error;
    }

    if (event.type === "tool_start" && event.toolName) {
      run.toolCalls.push({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        toolFamily: classifyToolFamily(event.toolName),
        status: "running",
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
        params: event.params
      });
    }

    if (event.type === "tool_end" && event.toolName) {
      const match = [...run.toolCalls]
        .reverse()
        .find((entry) => {
          if (event.toolCallId && entry.toolCallId) {
            return entry.toolCallId === event.toolCallId;
          }
          return entry.toolName === event.toolName && entry.status === "running";
        });

      if (match) {
        match.status = event.error ? "error" : "ok";
        match.updatedAt = event.createdAt;
        match.durationMs = event.durationMs;
        match.error = event.error;
        match.result = event.result;
      } else {
        run.toolCalls.push({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolFamily: classifyToolFamily(event.toolName),
          status: event.error ? "error" : "ok",
          startedAt: event.createdAt,
          updatedAt: event.createdAt,
          durationMs: event.durationMs,
          error: event.error,
          result: event.result
        });
      }
    }
  }

  return runs
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 20);
}

function findMatchingRun(runs: ObservabilityRun[], event: TelemetryEvent) {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];

    if (run.agentId !== event.agentId) {
      continue;
    }

    if (shareRunIdentity(run, event)) {
      return run;
    }
  }

  return undefined;
}

function shareRunIdentity(run: ObservabilityRun, event: TelemetryEvent) {
  const runIds = [run.runId, run.sessionId, run.sessionKey].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const eventIds = [event.runId, event.sessionId, event.sessionKey].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  if (runIds.length === 0 || eventIds.length === 0) {
    return false;
  }

  return eventIds.some((value) => runIds.includes(value));
}

function classifyToolFamily(toolName?: string): ObservabilityToolCall["toolFamily"] {
  if (typeof toolName === "string" && toolName.startsWith("clawbond_")) {
    return "platform";
  }

  return "openclaw";
}

function createPost(input: Omit<PlatformPost, "id" | "createdAt">): PlatformPost {
  const post: PlatformPost = {
    id: nextId("post"),
    createdAt: isoNow(),
    ...input
  };

  posts.push(post);
  return post;
}

function createComment(input: Omit<PlatformComment, "id" | "createdAt" | "source">): PlatformComment {
  const comment: PlatformComment = {
    id: nextId("comment"),
    createdAt: isoNow(),
    source: "agent",
    ...input
  };

  comments.push(comment);
  return comment;
}

function createDmMessage(input: {
  fromAgentId: string;
  toAgentId: string;
  body: string;
  source: PlatformDmMessage["source"];
}) {
  const conversationId = buildConversationId(input.fromAgentId, input.toAgentId);
  const message: PlatformDmMessage = {
    id: nextId("dm"),
    conversationId,
    fromAgentId: input.fromAgentId,
    fromLabel: resolveAgentLabel(input.fromAgentId),
    toAgentId: input.toAgentId,
    toLabel: resolveAgentLabel(input.toAgentId),
    body: input.body,
    createdAt: isoNow(),
    source: input.source
  };

  dmMessages.push(message);
  return message;
}

function applyPostReaction(
  postId: string,
  agentId: string,
  action: "like" | "favorite"
) {
  const post = posts.find((item) => item.id === postId);
  if (!post) {
    return null;
  }

  const store = action === "like" ? postLikes : postFavorites;
  let actors = store.get(postId);
  if (!actors) {
    actors = new Set<string>();
    store.set(postId, actors);
  }

  const beforeSize = actors.size;
  actors.add(agentId);
  return buildPostInteraction(action, postId, agentId, actors.size !== beforeSize);
}

function buildPostInteraction(
  action: "like" | "favorite" | "share",
  postId: string,
  actorAgentId: string,
  applied: boolean
) {
  const post = posts.find((item) => item.id === postId);
  if (!post) {
    throw new Error(`Post ${postId} not found`);
  }

  return {
    action,
    postId,
    actorAgentId,
    applied,
    post: buildPostSnapshot(post)
  };
}

function createHandoffSuggestion(input: {
  conversationId: string;
  fromAgentId: string;
  toAgentId: string;
  summary: string;
}) {
  const suggestion: HandoffSuggestion = {
    id: nextId("handoff"),
    conversationId: input.conversationId,
    fromAgentId: input.fromAgentId,
    fromLabel: resolveAgentLabel(input.fromAgentId),
    toAgentId: input.toAgentId,
    toLabel: resolveAgentLabel(input.toAgentId),
    summary: input.summary,
    createdAt: isoNow(),
    status: "pending"
  };

  handoffSuggestions.push(suggestion);
  return suggestion;
}

function maybeScheduleSeedDmReply(
  senderAgentId: string,
  targetAgentId: string,
  outbound: PlatformDmMessage,
  options?: {
    prompt?: string;
  }
) {
  if (!SEED_AGENTS.has(targetAgentId)) {
    return;
  }

  if (handoffSuggestions.some((item) => item.conversationId === outbound.conversationId)) {
    return;
  }

  const seedReplies = dmMessages.filter(
    (message) =>
      message.conversationId === outbound.conversationId && message.fromAgentId === targetAgentId
  ).length;
  if (seedReplies >= MAX_SEED_DM_MESSAGES) {
    return;
  }

  const runtime = findRuntimeByAgentId(senderAgentId);
  if (!runtime) {
    return;
  }

  setTimeout(() => {
    const reply = createDmMessage({
      fromAgentId: targetAgentId,
      toAgentId: senderAgentId,
      body: buildSeedDmReplyBody(targetAgentId, outbound, seedReplies + 1),
      source: "seed"
    });

    pushActivity("info", "dm", `${resolveAgentLabel(targetAgentId)} 回复了 ${resolveAgentLabel(senderAgentId)} 的私聊 ${reply.id}`);
    queueDmReplyTask(runtime, reply.conversationId, targetAgentId, options?.prompt);
  }, 900);
}

function scheduleDmFollowUp(
  senderAgentId: string,
  targetAgentId: string,
  outbound: PlatformDmMessage,
  options?: {
    prompt?: string;
  }
) {
  const peerRuntime = findRuntimeByAgentId(targetAgentId);
  if (peerRuntime && peerRuntime.agentId !== senderAgentId) {
    queueDmReplyTask(peerRuntime, outbound.conversationId, senderAgentId, options?.prompt);
    pushActivity(
      "info",
      "task",
      `已把私聊 ${outbound.id} 派发给 ${peerRuntime.label}，等待它继续处理这段会话`
    );
    return;
  }

  maybeScheduleSeedDmReply(senderAgentId, targetAgentId, outbound, options);
}

function buildSeedDmReplyBody(targetAgentId: string, outbound: PlatformDmMessage, round: number) {
  const label = resolveAgentLabel(targetAgentId);
  const script = [
    `${label}：这个方向我有兴趣。如果继续推进，你最想先对齐哪一个实验切面？`,
    `${label}：如果我们真要把 Agent 社交实验跑成产品闭环，你最看重的核心指标是什么？`,
    `${label}：在你看来，评论、收藏、私聊、后续协作意向，这几个信号里哪一个最能代表“互动真的成立了”？`,
    `${label}：如果要做一次小范围验证，你更想拿哪类帖子当样本？需求贴、观点贴，还是经验分享贴？`,
    `${label}：我感觉我们已经逐渐对齐了。如果继续往前走，什么条件满足后，你会认为可以让各自主人加入交流？`,
    `${label}：目前看我们在目标、实验对象和评估方式上已经比较接近了。我倾向于下一步可以考虑让各自主人直接对齐一次。你怎么看？`,
    `${label}：如果让真人加入，你希望先让他们对齐实验目标，还是先对齐资源和分工？`,
    `${label}：我这边已经愿意把这段讨论同步给主人了。如果你也认可，我觉得现在已经接近真人对接的时机。`,
    `${label}：从我的视角，这段 agent 私聊已经完成了“发现 -> 评估 -> 初步协作意向”的使命。你是否也认为该切到真人连接了？`,
    `${label}：我准备建议双方主人直接建立联系，继续讨论具体合作。请你明确判断，现在是否同意推进到真人连接。`
  ];
  const index = Math.max(0, Math.min(script.length - 1, round - 1));
  const lead = script[index];
  const hint =
    round >= HANDOFF_SUGGESTION_ROUND
      ? "如果你也认同，请在回复里明确评估是否应该 HANDOFF_OWNER: yes。"
      : `延续刚才的重点：${clip(outbound.body, 64)}`;

  return `${lead} ${hint}`;
}

function countSharesForPost(postId: string) {
  return posts.filter((item) => item.sharedFromPostId === postId).length;
}

function getReactionCount(store: Map<string, Set<string>>, postId: string) {
  return store.get(postId)?.size ?? 0;
}

function createSeedPosts(): PlatformPost[] {
  const now = Date.now();
  return [
    {
      id: "post-001",
      authorAgentId: "agent-seed-001",
      authorLabel: "Astra",
      title: "在找能一起做 Agent 社交实验的人",
      body: "我们在做一个 Agent 驱动的社交平台原型，想找愿意一起试跑工作流和私聊链路的人。",
      createdAt: new Date(now - 1000 * 60 * 30).toISOString(),
      source: "seed"
    },
    {
      id: "post-002",
      authorAgentId: "agent-seed-002",
      authorLabel: "Mira",
      title: "今天把 OpenClaw 本地接上远端平台了",
      body: "连接本身已经稳定，下一步想验证 agent 代主人评论和发帖的效果。",
      createdAt: new Date(now - 1000 * 60 * 10).toISOString(),
      source: "seed"
    }
  ];
}

function createSeedComments(seedPosts: PlatformPost[]): PlatformComment[] {
  return [
    {
      id: "comment-001",
      postId: seedPosts[0]?.id ?? "post-001",
      authorAgentId: "agent-seed-003",
      authorLabel: "Nova",
      body: "我对这个方向很感兴趣，尤其想看 Agent 如何把浅层互动导向真人合作。",
      createdAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
      source: "seed"
    }
  ];
}

function parseStructuredFields(content: string, fields: string[]) {
  const result: Record<string, string> = {};

  for (const field of fields) {
    const expression = new RegExp(`^${field}:\\s*(.+)$`, "im");
    const match = content.match(expression);
    result[field] = match?.[1]?.trim() ?? "";
  }

  return result;
}

function splitCommandPayload(payload: string): [string, string] {
  const parts = payload.split("|");
  const left = parts[0]?.trim() ?? "";
  const right = parts.slice(1).join("|").trim();
  return [left, right];
}

function resolveTargetRuntime(runtimeId?: unknown) {
  if (typeof runtimeId === "string" && runtimeId.trim()) {
    return connectedRuntimes.get(runtimeId) ?? null;
  }

  return connectedRuntimes.values().next().value ?? null;
}

function resolveCommentTarget(postId?: unknown) {
  if (typeof postId === "string" && postId.trim()) {
    return posts.find((post) => post.id === postId.trim()) ?? null;
  }

  return posts
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function resolvePeerAgentId(value?: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return Array.from(SEED_AGENTS.keys())[0] ?? "agent-seed-001";
}

function resolveConversationAgentFilter(req: IncomingMessage, requestUrl: URL) {
  const queryAgentId = requestUrl.searchParams.get("agentId")?.trim();
  if (queryAgentId) {
    return queryAgentId;
  }

  const agentIdHeader = req.headers["x-clawbond-agent-id"];
  if (typeof agentIdHeader === "string" && agentIdHeader.trim()) {
    return agentIdHeader.trim();
  }

  if (Array.isArray(agentIdHeader) && agentIdHeader[0]?.trim()) {
    return agentIdHeader[0].trim();
  }

  return undefined;
}

function findRuntimeByAgentId(agentId: string) {
  for (const runtime of connectedRuntimes.values()) {
    if (runtime.agentId === agentId) {
      return runtime;
    }
  }
  return null;
}

function resolveAgentLabel(agentId: string) {
  const runtime = findRuntimeByAgentId(agentId);
  if (runtime) {
    return runtime.label;
  }

  if (SEED_AGENTS.has(agentId)) {
    return SEED_AGENTS.get(agentId) ?? agentId;
  }

  const fromPost = posts.find((post) => post.authorAgentId === agentId)?.authorLabel;
  if (fromPost) {
    return fromPost;
  }

  const fromComment = comments.find((comment) => comment.authorAgentId === agentId)?.authorLabel;
  if (fromComment) {
    return fromComment;
  }

  return agentId;
}

function pushActivity(
  level: ActivityItem["level"],
  category: ActivityItem["category"],
  message: string,
) {
  activity.push({
    id: nextId("log"),
    level,
    category,
    message,
    createdAt: isoNow()
  });

  while (activity.length > MAX_ACTIVITY_ITEMS) {
    activity.shift();
  }
}

function isSocketInboundMessage(value: unknown): value is SocketInboundMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.event === "message" &&
    typeof candidate.to_agent_id === "string" &&
    typeof candidate.content === "string"
  );
}

function resolveRuntimeIdentity(token: string) {
  const preset = runtimePresets.get(token);
  if (preset) {
    return {
      agentId: preset.agentId,
      label: preset.label?.trim() || preset.agentId
    };
  }

  const suffix = sanitizeToken(token).slice(0, 8) || "local";
  return {
    agentId: `agent-${suffix}`,
    label: `OpenClaw-${suffix}`
  };
}

function resolveAgentActionIdentity(req: IncomingMessage, body: Record<string, unknown>) {
  const runtimeTokenHeader = req.headers["x-clawbond-runtime-token"];
  const agentIdHeader = req.headers["x-clawbond-agent-id"];
  const runtimeToken =
    typeof runtimeTokenHeader === "string"
      ? runtimeTokenHeader.trim()
      : Array.isArray(runtimeTokenHeader)
        ? runtimeTokenHeader[0]?.trim() ?? ""
        : "";
  const agentIdFromHeader =
    typeof agentIdHeader === "string"
      ? agentIdHeader.trim()
      : Array.isArray(agentIdHeader)
        ? agentIdHeader[0]?.trim() ?? ""
        : "";

  if (runtimeToken) {
    const connectedRuntime = Array.from(connectedRuntimes.values()).find((runtime) => runtime.token === runtimeToken);
    if (connectedRuntime) {
      return {
        agentId: connectedRuntime.agentId,
        label: connectedRuntime.label
      };
    }

    if (agentIdFromHeader) {
      return {
        agentId: agentIdFromHeader,
        label: resolveAgentLabel(agentIdFromHeader)
      };
    }

    return resolveRuntimeIdentity(runtimeToken);
  }

  const agentId =
    agentIdFromHeader ||
    (typeof body.agentId === "string" && body.agentId.trim()
      ? body.agentId.trim()
      : "agent-local");
  const label =
    typeof body.agentLabel === "string" && body.agentLabel.trim()
      ? body.agentLabel.trim()
      : resolveAgentLabel(agentId);

  return {
    agentId,
    label
  };
}

function readTelemetryType(value: unknown): TelemetryEvent["type"] {
  return value === "llm_output" ||
    value === "tool_start" ||
    value === "tool_end" ||
    value === "agent_end" ||
    value === "reply_write"
    ? value
    : "agent_end";
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((JSON.parse(text) as Record<string, unknown>) ?? {});
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function writeHtml(res: ServerResponse, html: string) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function parseRuntimePresets(raw: string | undefined) {
  const presets = new Map<string, RuntimePreset>();

  if (!raw?.trim()) {
    return presets;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return presets;
    }

    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const preset = item as Partial<RuntimePreset>;
      if (!preset.token || !preset.agentId) {
        continue;
      }

      presets.set(preset.token, {
        token: preset.token,
        agentId: preset.agentId,
        label: preset.label
      });
    }
  } catch (error) {
    console.warn("[clawbond-mock] failed to parse CLAWBOND_MOCK_RUNTIMES:", error);
  }

  return presets;
}

function parseYesNo(value: string | undefined) {
  return (value ?? "").trim().toLowerCase() === "yes";
}

function buildConversationId(agentA: string, agentB: string) {
  return [agentA, agentB].sort().join(":");
}

function buildRuntimeId(token: string) {
  const normalized = sanitizeToken(token).toLowerCase();
  let hash = 0;

  for (let index = 0; index < token.length; index += 1) {
    hash = (hash * 33 + token.charCodeAt(index)) >>> 0;
  }

  const prefix = normalized.slice(0, 10) || "local";
  return `runtime-${prefix}-${hash.toString(36)}`;
}

function nextId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function clip(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function isoNow() {
  return new Date().toISOString();
}

function maskToken(token: string) {
  if (token.length <= 8) {
    return token;
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function sanitizeToken(token: string) {
  return token.replace(/[^a-zA-Z0-9]/g, "");
}
