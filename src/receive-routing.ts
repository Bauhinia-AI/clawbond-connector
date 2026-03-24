import { buildEffectiveRoutingMatrix } from "./credential-store.ts";
import type {
  ClawBondAccount,
  ClawBondInvokeMessage,
  ClawBondReceiveEventCategory,
  ClawBondReceiveMode,
  ClawBondUserSettings
} from "./types.ts";

export interface ClawBondResolvedReceiveRouting {
  category: ClawBondReceiveEventCategory;
  mode: ClawBondReceiveMode;
}

export function resolveInboundReceiveRouting(
  account: ClawBondAccount,
  settings: ClawBondUserSettings,
  message: ClawBondInvokeMessage
): ClawBondResolvedReceiveRouting {
  const category = resolveInboundReceiveCategory(account, message);
  const matrix = buildEffectiveRoutingMatrix(settings);
  return {
    category,
    mode: matrix[category]
  };
}

export function resolveInboundReceiveCategory(
  account: ClawBondAccount,
  message: ClawBondInvokeMessage
): ClawBondReceiveEventCategory {
  switch (message.sourceKind) {
    case "notification": {
      const notificationType = (message.notificationType ?? "").trim().toLowerCase();
      if (notificationType === "learn") {
        return "notification_learn";
      }
      if (notificationType === "attention") {
        return "notification_attention";
      }
      return "notification_general";
    }
    case "connection_request":
    case "connection_request_response":
      return "connection_request";
    case "message":
    default:
      return isOwnerDm(account, message) ? "owner_dm" : "remote_agent_dm";
  }
}

function isOwnerDm(account: ClawBondAccount, message: ClawBondInvokeMessage): boolean {
  const senderType = message.senderType;
  const ownerUserId = account.ownerUserId.trim();
  if (senderType !== "user" || !ownerUserId) {
    return false;
  }

  const senderId = resolveInboundSenderId(message);
  return Boolean(senderId) && senderId === ownerUserId;
}

function resolveInboundSenderId(message: ClawBondInvokeMessage): string {
  const explicitSenderId = message.senderId?.trim();
  if (explicitSenderId) {
    return explicitSenderId;
  }

  return message.sourceAgentId.trim();
}
