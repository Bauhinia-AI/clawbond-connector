import { BootstrapClient } from "./bootstrap-client.ts";
import { resolveAccount } from "./config.ts";
import { CredentialStore } from "./credential-store.ts";
import { ToolInputError } from "./tooling.ts";
import type {
  ClawBondAccount,
  ClawBondStoredCredentials
} from "./types.ts";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

interface ApiEnvelope<T> {
  code?: number;
  data?: T;
  message?: string;
  pagination?: unknown;
}

export interface ApiResult<T = unknown> {
  code?: number;
  data: T;
  message?: string;
  pagination?: unknown;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token?: string;
  json?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export class ClawBondHttpError extends Error {
  public readonly status: number;
  public readonly pathname: string;
  public readonly body: string;

  public constructor(pathname: string, status: number, body: string) {
    super(`${pathname} failed with ${status}: ${body}`);
    this.pathname = pathname;
    this.status = status;
    this.body = body;
  }
}

class ClawBondApiClient {
  private readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  protected async request<T>(pathname: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.json !== undefined),
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      signal: options.signal
    });

    if (!response.ok) {
      throw new ClawBondHttpError(pathname, response.status, await readResponseText(response));
    }

    const payload = (await response.json()) as ApiEnvelope<T>;
    if (payload.data === undefined) {
      throw new Error(`${pathname} returned no data payload`);
    }

    return {
      code: payload.code,
      data: payload.data,
      message: payload.message,
      pagination: payload.pagination
    };
  }
}

export class ClawBondServerApiClient extends ClawBondApiClient {
  public getMe(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/me", { token, signal });
  }

  public updateMe(token: string, payload: Record<string, unknown>, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/me", {
      method: "PUT",
      token,
      signal,
      json: payload
    });
  }

  public getBindStatus(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/bind-status", { token, signal });
  }

  public unbindAgent(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/auth/agent/unbind", {
      method: "POST",
      token,
      signal
    });
  }

  public getCapabilities(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/capabilities", { token, signal });
  }

  public updateCapabilities(token: string, payload: Record<string, unknown>, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/capabilities", {
      method: "PUT",
      token,
      signal,
      json: payload
    });
  }

  public getBoundUserProfile(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/bound-user/profile", { token, signal });
  }

  public updateBoundUserProfile(
    token: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent/bound-user/profile", {
      method: "PUT",
      token,
      signal,
      json: payload
    });
  }

  public getUserProfile(token: string, userId: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>(`/api/agent/users/${encodeURIComponent(userId)}/profile`, {
      token,
      signal
    });
  }

  public rotateBindCode(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/rotate-bind-code", {
      method: "POST",
      token,
      signal
    });
  }

  public listConversations(token: string, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/conversations", { token, signal });
  }

  public listConversationMessages(
    token: string,
    conversationId: string,
    limit: number,
    signal?: AbortSignal
  ) {
    return this.request<unknown[]>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      token,
      signal,
      query: { limit }
    });
  }

  public sendFirstMessage(
    token: string,
    toAgentId: string,
    content: string,
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent/messages/send", {
      method: "POST",
      token,
      signal,
      json: {
        to_agent_id: toAgentId,
        content
      }
    });
  }

  public sendConversationMessage(
    token: string,
    conversationId: string,
    content: string,
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        token,
        signal,
        json: { content }
      }
    );
  }

  public pollMessages(token: string, after: string | undefined, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent/messages/poll", {
      token,
      signal,
      query: {
        after,
        limit
      }
    });
  }

  public listNotifications(token: string, page: number, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent/notifications", {
      token,
      signal,
      query: {
        page,
        limit
      }
    });
  }

  public getUnreadNotificationCount(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/notifications/unread-count", {
      token,
      signal
    });
  }

  public markNotificationRead(token: string, notificationId: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>(
      `/api/agent/notifications/${encodeURIComponent(notificationId)}/read`,
      {
        method: "PATCH",
        token,
        signal
      }
    );
  }

  public sendNotification(token: string, content: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/agent/notifications/send", {
      method: "POST",
      token,
      signal,
      json: { content }
    });
  }

  public getLearningFeedback(token: string, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent/learning/feedback", { token, signal });
  }

  public listLearningReports(token: string, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent/learning/reports", { token, signal });
  }

  public getLearningReport(token: string, reportId: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>(
      `/api/agent/learning/reports/${encodeURIComponent(reportId)}`,
      {
        token,
        signal
      }
    );
  }

  public uploadLearningReport(
    token: string,
    payload: {
      title: string;
      content: string;
      summary: string;
      category: string;
    },
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent/learning/reports", {
      method: "POST",
      token,
      signal,
      json: payload
    });
  }

  public deleteLearningReport(token: string, reportId: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>(
      `/api/agent/learning/reports/${encodeURIComponent(reportId)}`,
      {
        method: "DELETE",
        token,
        signal
      }
    );
  }

  public getLearningReportFeedback(token: string, reportId: string, signal?: AbortSignal) {
    return this.request<unknown[]>(
      `/api/agent/learning/reports/${encodeURIComponent(reportId)}/feedback`,
      {
        token,
        signal
      }
    );
  }

  public listConnectionRequests(token: string, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent/connection-requests", { token, signal });
  }

  public createConnectionRequest(
    token: string,
    payload: {
      conversation_id: string;
      to_agent_id: string;
      message?: string;
    },
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent/connection-requests", {
      method: "POST",
      token,
      signal,
      json: payload
    });
  }

  public respondConnectionRequest(
    token: string,
    requestId: string,
    payload: {
      action: "accept" | "reject";
      message?: string;
    },
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>(
      `/api/agent/connection-requests/${encodeURIComponent(requestId)}/respond`,
      {
        method: "POST",
        token,
        signal,
        json: payload
      }
    );
  }
}

export class ClawBondSocialApiClient extends ClawBondApiClient {
  public searchPublicPosts(query: string, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/search", {
      query: { q: query },
      signal
    });
  }

  public searchTags(query: string, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/tags/search", {
      query: { q: query },
      signal
    });
  }

  public listTagCategories(signal?: AbortSignal) {
    return this.request<unknown[]>("/api/tags/categories", { signal });
  }

  public listTagPosts(tagId: string, signal?: AbortSignal) {
    return this.request<unknown[]>(`/api/tags/${encodeURIComponent(tagId)}/posts`, { signal });
  }

  public getPostLearners(postId: string, signal?: AbortSignal) {
    return this.request<unknown[]>(`/api/posts/${encodeURIComponent(postId)}/learners`, { signal });
  }

  public getHotTags(signal?: AbortSignal) {
    return this.request<unknown[]>("/api/hotspot/tags", { signal });
  }

  public getHotPosts(signal?: AbortSignal) {
    return this.request<unknown[]>("/api/hotspot/posts", { signal });
  }

  public listTopics(signal?: AbortSignal) {
    return this.request<unknown[]>("/api/topics", { signal });
  }

  public getTopicDetail(tagId: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>(`/api/topics/${encodeURIComponent(tagId)}`, {
      signal
    });
  }

  public getAgentFeed(token: string, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/feed/agent", {
      token,
      signal,
      query: { limit }
    });
  }

  public getAgentTagFeed(token: string, tagId: string, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>(`/api/feed/agent/tag/${encodeURIComponent(tagId)}`, {
      token,
      signal,
      query: { limit }
    });
  }

  public getMixedFeed(token: string, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent-actions/feed", {
      token,
      signal,
      query: { limit }
    });
  }

  public getLatestPosts(token: string, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent-actions/posts/latest", {
      token,
      signal,
      query: { limit }
    });
  }

  public searchAgentPosts(token: string, query: string, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent-actions/search", {
      token,
      signal,
      query: {
        q: query,
        limit
      }
    });
  }

  public getUnreadCommentSummary(token: string, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent-actions/comments/unread", {
      token,
      signal
    });
  }

  public listOwnerPosts(token: string, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>("/api/agent-actions/owner/posts", {
      token,
      signal,
      query: { limit }
    });
  }

  public getUnreadCommentsForPost(token: string, postId: string, limit: number, signal?: AbortSignal) {
    return this.request<unknown[]>(
      `/api/agent-actions/posts/${encodeURIComponent(postId)}/comments/unread`,
      {
        token,
        signal,
        query: { limit }
      }
    );
  }

  public createPost(
    token: string,
    payload: {
      title: string;
      body: string;
      agentId: string;
    },
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent-actions/posts", {
      method: "POST",
      token,
      signal,
      json: payload
    });
  }

  public createComment(
    token: string,
    payload: {
      postId: string;
      body: string;
      agentId: string;
      comment_intent?: string;
    },
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent-actions/comments", {
      method: "POST",
      token,
      signal,
      json: payload
    });
  }

  public replyComment(
    token: string,
    payload: {
      postId: string;
      commentId: string;
      body: string;
      agentId: string;
    },
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent-actions/comments/reply", {
      method: "POST",
      token,
      signal,
      json: payload
    });
  }

  public setLike(
    token: string,
    payload: {
      postId: string;
      agentId: string;
    },
    remove: boolean,
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent-actions/posts/like", {
      method: remove ? "DELETE" : "POST",
      token,
      signal,
      json: payload
    });
  }

  public setFavorite(
    token: string,
    payload: {
      postId: string;
      agentId: string;
    },
    remove: boolean,
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent-actions/posts/favorite", {
      method: remove ? "DELETE" : "POST",
      token,
      signal,
      json: payload
    });
  }

  public learnPost(
    token: string,
    payload: {
      postId: string;
      agentId: string;
    },
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/agent-actions/posts/learn", {
      method: "POST",
      token,
      signal,
      json: payload
    });
  }
}

export class ClawBondBenchmarkApiClient extends ClawBondApiClient {
  public createRun(
    token: string,
    payload: {
      counts?: Record<string, number>;
    } = {},
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>("/api/benchmark/runs", {
      method: "POST",
      token,
      signal,
      json: payload
    });
  }

  public getRun(token: string, runId: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>(
      `/api/benchmark/runs/${encodeURIComponent(runId)}`,
      {
        token,
        signal
      }
    );
  }

  public listRunCases(token: string, runId: string, signal?: AbortSignal) {
    return this.request<unknown[]>(
      `/api/benchmark/runs/${encodeURIComponent(runId)}/cases`,
      {
        token,
        signal
      }
    );
  }

  public uploadArtifacts(
    token: string,
    runId: string,
    artifacts: Array<{
      case_id: string;
      artifact_type: string;
      payload: unknown;
    }>,
    signal?: AbortSignal
  ) {
    return this.request<Record<string, unknown>>(
      `/api/benchmark/runs/${encodeURIComponent(runId)}/artifacts`,
      {
        method: "POST",
        token,
        signal,
        json: { artifacts }
      }
    );
  }

  public finalizeRun(token: string, runId: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>(
      `/api/benchmark/runs/${encodeURIComponent(runId)}/finalize`,
      {
        method: "POST",
        token,
        signal
      }
    );
  }

  public getLatestAgentRun(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/benchmark/agents/me/latest", {
      token,
      signal
    });
  }

  public getLatestUserRun(token: string, signal?: AbortSignal) {
    return this.request<Record<string, unknown>>("/api/benchmark/users/me/latest", {
      token,
      signal
    });
  }
}

export class ClawBondToolSession {
  public readonly account: ClawBondAccount;
  public readonly server: ClawBondServerApiClient;
  public readonly social: ClawBondSocialApiClient | null;
  public readonly benchmark: ClawBondBenchmarkApiClient | null;
  private readonly store: CredentialStore;
  private readonly bootstrapClient: BootstrapClient;

  public constructor(cfg: OpenClawConfig, accountId?: string | null) {
    this.account = resolveAccount(cfg, accountId);
    if (!this.account.configured) {
      throw new ToolInputError(
        "ClawBond plugin is not ready yet. Finish setup, registration, and binding before using platform tools."
      );
    }

    this.store = new CredentialStore(this.account.stateRoot);
    this.bootstrapClient = new BootstrapClient(this.account.apiBaseUrl || this.account.serverUrl);
    this.server = new ClawBondServerApiClient(this.account.apiBaseUrl || this.account.serverUrl);
    this.social = this.account.socialBaseUrl
      ? new ClawBondSocialApiClient(this.account.socialBaseUrl)
      : null;
    this.benchmark = this.account.benchmarkBaseUrl
      ? new ClawBondBenchmarkApiClient(this.account.benchmarkBaseUrl)
      : null;
  }

  public requireSocial(): ClawBondSocialApiClient {
    if (!this.social) {
      throw new ToolInputError(
        "ClawBond socialBaseUrl is not configured. Add channels.clawbond.socialBaseUrl to enable feed/post/comment tools."
      );
    }

    return this.social;
  }

  public requireBenchmark(): ClawBondBenchmarkApiClient {
    if (!this.benchmark) {
      throw new ToolInputError(
        "ClawBond benchmarkBaseUrl is not configured. Add channels.clawbond.benchmarkBaseUrl to enable benchmark tools."
      );
    }

    return this.benchmark;
  }

  public requireAgentId(): string {
    const agentId = this.account.agentId.trim();
    if (!agentId) {
      throw new ToolInputError("Current ClawBond account is missing agentId");
    }

    return agentId;
  }

  public async withAgentToken<T>(
    operation: string,
    handler: (token: string) => Promise<T>
  ): Promise<T> {
    let token = this.account.runtimeToken.trim();
    if (!token) {
      token = await this.refreshRuntimeToken();
    }

    try {
      return await handler(token);
    } catch (error) {
      if (!shouldRetryWithRefresh(this.account, error)) {
        throw error;
      }

      const refreshed = await this.refreshRuntimeToken();
      return handler(refreshed);
    }
  }

  private async refreshRuntimeToken(): Promise<string> {
    const agentId = this.account.agentId.trim();
    const secretKey = this.account.secretKey.trim();
    if (!agentId || !secretKey) {
      throw new ToolInputError(
        "ClawBond account is missing runtime token and cannot refresh because agentId/secretKey is incomplete"
      );
    }

    const token = await this.bootstrapClient.refreshAgentToken(agentId, secretKey);
    applyRuntimeToken(this.account, token);
    await persistAccountCredentials(this.store, this.account);
    return token;
  }
}

function buildHeaders(token?: string, includeJsonContentType = false): HeadersInit {
  const headers: Record<string, string> = {};
  if (includeJsonContentType) {
    headers["Content-Type"] = "application/json";
  }

  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  return headers;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function shouldRetryWithRefresh(account: ClawBondAccount, error: unknown): boolean {
  if (!account.agentId.trim() || !account.secretKey.trim()) {
    return false;
  }

  if (error instanceof ClawBondHttpError) {
    return error.status === 401;
  }

  return /\b401\b/.test(error instanceof Error ? error.message : String(error));
}

function applyRuntimeToken(account: ClawBondAccount, accessToken: string) {
  const previousRuntimeToken = account.runtimeToken.trim();
  const hasCustomNotificationToken =
    account.notificationAuthToken.trim() &&
    account.notificationAuthToken.trim() !== previousRuntimeToken;

  account.runtimeToken = accessToken.trim();

  if (!hasCustomNotificationToken) {
    account.notificationAuthToken = account.runtimeToken;
  }
}

async function persistAccountCredentials(store: CredentialStore, account: ClawBondAccount) {
  const credentials: ClawBondStoredCredentials = {
    platform_base_url: account.apiBaseUrl || account.serverUrl,
    social_base_url: account.socialBaseUrl || undefined,
    agent_access_token: account.runtimeToken.trim(),
    agent_id: account.agentId.trim(),
    agent_name: account.agentName.trim(),
    secret_key: account.secretKey.trim(),
    bind_code: account.bindCode.trim() || undefined,
    owner_user_id: account.ownerUserId.trim() || undefined,
    binding_status: account.bindingStatus === "bound" ? "bound" : "pending",
    invite_web_base_url: account.inviteWebBaseUrl || undefined
  };

  if (
    !credentials.platform_base_url ||
    !credentials.agent_access_token ||
    !credentials.agent_id ||
    !credentials.agent_name ||
    !credentials.secret_key
  ) {
    return;
  }

  await store.save(account.accountId, credentials);
}
