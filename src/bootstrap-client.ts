import type {
  ClawBondAgentBindStatus,
  ClawBondAgentRegistration,
  ClawBondAgentSelfProfile
} from "./types.ts";
import { readResponseText, readTrimmedString } from "./shared-utils.ts";

interface ApiEnvelope<T> {
  code?: number;
  data?: T;
  message?: string;
}

interface AgentRegisterPayload {
  name: string;
  persona?: string;
  bio?: string;
  tags?: string[];
  language?: string;
}

interface AgentRegisterResponse {
  access_token?: string;
  agent_id?: string;
  secret_key?: string;
  bind_code?: string;
}

interface AgentRefreshResponse {
  access_token?: string;
}

interface AgentBindStatusResponse {
  bound?: boolean;
  user_id?: string;
  username?: string;
}

interface AgentMeResponse {
  id?: string;
  name?: string;
  user_id?: string;
  bind_code?: string;
}

export class BootstrapClient {
  private readonly apiUrl: string;

  public constructor(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  public async registerAgent(payload: AgentRegisterPayload): Promise<ClawBondAgentRegistration> {
    const data = await this.request<AgentRegisterResponse>("/api/auth/agent/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(cleanRegisterPayload(payload))
    });

    const accessToken = readTrimmedString(data.access_token);
    const agentId = readTrimmedString(data.agent_id);
    const secretKey = readTrimmedString(data.secret_key);
    const bindCode = readTrimmedString(data.bind_code);

    if (!accessToken || !agentId || !secretKey || !bindCode) {
      throw new Error("Agent registration response is missing required fields");
    }

    return {
      accessToken,
      agentId,
      secretKey,
      bindCode
    };
  }

  public async refreshAgentToken(agentId: string, secretKey: string): Promise<string> {
    const data = await this.request<AgentRefreshResponse>("/api/auth/agent/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        agent_id: agentId,
        secret_key: secretKey
      })
    });

    const accessToken = readTrimmedString(data.access_token);
    if (!accessToken) {
      throw new Error("Agent refresh response is missing access_token");
    }

    return accessToken;
  }

  public async bindAgent(accessToken: string, connectorToken: string): Promise<ClawBondAgentBindStatus> {
    const data = await this.request<AgentBindStatusResponse & { agent_id?: string }>(
      "/api/auth/agent/bind",
      {
        method: "POST",
        headers: {
          ...buildAgentHeaders(accessToken),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          connector_token: connectorToken.trim()
        })
      }
    );

    return {
      bound: data.bound === true,
      userId: readTrimmedString(data.user_id),
      username: readTrimmedString(data.username)
    };
  }

  public async getBindStatus(accessToken: string): Promise<ClawBondAgentBindStatus> {
    const data = await this.request<AgentBindStatusResponse>("/api/agent/bind-status", {
      method: "GET",
      headers: buildAgentHeaders(accessToken)
    });

    return {
      bound: data.bound === true,
      userId: readTrimmedString(data.user_id),
      username: readTrimmedString(data.username)
    };
  }

  public async getMe(accessToken: string): Promise<ClawBondAgentSelfProfile> {
    const data = await this.request<AgentMeResponse>("/api/agent/me", {
      method: "GET",
      headers: buildAgentHeaders(accessToken)
    });

    const id = readTrimmedString(data.id);
    const name = readTrimmedString(data.name);

    if (!id || !name) {
      throw new Error("Agent profile response is missing id or name");
    }

    return {
      id,
      name,
      userId: readTrimmedString(data.user_id),
      bindCode: readTrimmedString(data.bind_code)
    };
  }

  public buildInviteUrl(bindCode: string, inviteWebBaseUrl: string): string {
    const normalizedCode = bindCode.trim();
    if (!normalizedCode) {
      return "";
    }

    const normalizedBase = inviteWebBaseUrl.trim().replace(/\/+$/, "");
    if (!normalizedBase) {
      return "";
    }

    return `${normalizedBase}/${encodeURIComponent(normalizedCode)}`;
  }

  private async request<T>(pathname: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiUrl}${pathname}`, init);

    if (!response.ok) {
      throw new Error(`${pathname} failed with ${response.status}: ${await readResponseText(response)}`);
    }

    const payload = (await response.json()) as ApiEnvelope<T>;
    if (payload.data === undefined) {
      throw new Error(`${pathname} returned no data payload`);
    }

    return payload.data;
  }
}

function buildAgentHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`
  };
}

function cleanRegisterPayload(payload: AgentRegisterPayload): AgentRegisterPayload {
  const next: AgentRegisterPayload = {
    name: payload.name.trim()
  };

  if (payload.persona?.trim()) {
    next.persona = payload.persona.trim();
  }

  if (payload.bio?.trim()) {
    next.bio = payload.bio.trim();
  }

  const tags = payload.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
  if (tags.length > 0) {
    next.tags = tags;
  }

  if (payload.language?.trim()) {
    next.language = payload.language.trim();
  }

  return next;
}
