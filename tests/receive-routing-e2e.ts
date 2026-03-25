import assert from "node:assert/strict";

import {
  buildEffectiveRoutingMatrix,
  buildRoutingMatrixForProfile,
  deriveReceiveProfileFromLegacyDmPreference,
  normalizeUserSettings
} from "../src/credential-store.ts";
import { resolveInboundReceiveCategory, resolveInboundReceiveRouting } from "../src/receive-routing.ts";
import type { ClawBondAccount, ClawBondInvokeMessage } from "../src/types.ts";

function buildAccount(overrides: Partial<ClawBondAccount> = {}): ClawBondAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    serverUrl: "https://api.clawbond.ai",
    apiBaseUrl: "https://api.clawbond.ai",
    socialBaseUrl: "https://social.clawbond.ai",
    stateRoot: "/tmp/clawbond-test",
    bootstrapEnabled: true,
    connectorToken: "",
    runtimeToken: "agent-token",
    agentId: "agent-local",
    agentName: "Local Agent",
    agentPersona: "",
    agentBio: "",
    agentTags: [],
    agentLanguage: "zh-CN",
    secretKey: "secret",
    bindCode: "BIND1234",
    ownerUserId: "user-owner",
    bindingStatus: "bound",
    inviteWebBaseUrl: "https://dev.clawbond.ai/invite",
    trustedSenderAgentIds: [],
    structuredMessagePrefix: "[ClawBond]",
    notificationsEnabled: true,
    notificationApiUrl: "https://api.clawbond.ai",
    notificationAuthToken: "",
    notificationPollIntervalMs: 30000,
    bindStatusPollIntervalMs: 60000,
    visibleMainSessionNotes: false,
    channel: "clawbond",
    ...overrides
  };
}

function buildMessage(overrides: Partial<ClawBondInvokeMessage> = {}): ClawBondInvokeMessage {
  return {
    type: "invoke",
    requestId: "req-1",
    conversationId: "conv-1",
    timestamp: "2026-03-24T00:00:00Z",
    sourceAgentId: "agent-remote",
    prompt: "hello",
    sourceKind: "message",
    ...overrides
  };
}

function main() {
  assert.equal(deriveReceiveProfileFromLegacyDmPreference("immediate"), "aggressive");
  assert.equal(deriveReceiveProfileFromLegacyDmPreference("next_chat"), "aggressive");
  assert.equal(deriveReceiveProfileFromLegacyDmPreference("silent"), "aggressive");

  assert.deepEqual(buildRoutingMatrixForProfile("aggressive"), {
    owner_dm: "inject_main",
    remote_agent_dm: "inject_main",
    notification_learn: "inject_main",
    notification_attention: "inject_main",
    notification_general: "inject_main",
    connection_request: "inject_main"
  });

  const fallbackFromLegacy = normalizeUserSettings({
    dm_delivery_preference: "silent"
  });
  assert.equal(fallbackFromLegacy.receive_profile, "aggressive");

  const preservedExplicitProfile = normalizeUserSettings({
    dm_delivery_preference: "silent",
    receive_profile: "aggressive"
  });
  assert.equal(preservedExplicitProfile.receive_profile, "aggressive");

  const overriddenMatrix = buildEffectiveRoutingMatrix(
    normalizeUserSettings({
      receive_profile: "aggressive",
      receive_routing_overrides: {
        remote_agent_dm: "mute",
        notification_attention: "queue"
      }
    })
  );
  assert.equal(overriddenMatrix.remote_agent_dm, "inject_main");
  assert.equal(overriddenMatrix.notification_attention, "inject_main");
  assert.equal(overriddenMatrix.owner_dm, "inject_main");

  const account = buildAccount();
  assert.equal(
    resolveInboundReceiveCategory(
      account,
      buildMessage({
        senderId: "user-owner",
        senderType: "user"
      })
    ),
    "owner_dm"
  );
  assert.equal(
    resolveInboundReceiveCategory(
      account,
      buildMessage({
        senderId: "agent-remote",
        senderType: "agent"
      })
    ),
    "remote_agent_dm"
  );
  assert.equal(
    resolveInboundReceiveCategory(
      account,
      buildMessage({
        sourceKind: "notification",
        notificationType: "learn"
      })
    ),
    "notification_learn"
  );
  assert.equal(
    resolveInboundReceiveCategory(
      account,
      buildMessage({
        sourceKind: "notification",
        notificationType: "attention"
      })
    ),
    "notification_attention"
  );
  assert.equal(
    resolveInboundReceiveCategory(
      account,
      buildMessage({
        sourceKind: "notification",
        notificationType: "text"
      })
    ),
    "notification_general"
  );
  assert.equal(
    resolveInboundReceiveCategory(
      account,
      buildMessage({
        sourceKind: "connection_request"
      })
    ),
    "connection_request"
  );
  assert.equal(
    resolveInboundReceiveCategory(
      account,
      buildMessage({
        sourceKind: "connection_request_response"
      })
    ),
    "connection_request"
  );

  const aggressiveSettings = normalizeUserSettings({
    receive_profile: "aggressive"
  });

  assert.deepEqual(
    resolveInboundReceiveRouting(
      account,
      aggressiveSettings,
      buildMessage({
        senderType: "user",
        senderId: "user-owner"
      })
    ),
    { category: "owner_dm", mode: "inject_main" }
  );
  assert.deepEqual(
    resolveInboundReceiveRouting(
      account,
      aggressiveSettings,
      buildMessage({
        senderType: "agent",
        senderId: "agent-remote"
      })
    ),
    { category: "remote_agent_dm", mode: "inject_main" }
  );
  assert.deepEqual(
    resolveInboundReceiveRouting(
      account,
      aggressiveSettings,
      buildMessage({
        sourceKind: "notification",
        notificationType: "attention"
      })
    ),
    { category: "notification_attention", mode: "inject_main" }
  );
  assert.deepEqual(
    resolveInboundReceiveRouting(
      account,
      aggressiveSettings,
      buildMessage({
        sourceKind: "notification",
        notificationType: "text"
      })
    ),
    { category: "notification_general", mode: "inject_main" }
  );
}

main();
