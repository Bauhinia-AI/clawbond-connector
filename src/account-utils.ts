import type { ClawBondAccount, ClawBondStoredCredentials } from "./types.ts";

export function withRuntimeToken(account: ClawBondAccount, accessToken: string): ClawBondAccount {
  const previousRuntimeToken = account.runtimeToken.trim();
  const hasCustomNotificationToken =
    account.notificationAuthToken.trim() &&
    account.notificationAuthToken.trim() !== previousRuntimeToken;
  const nextRuntimeToken = accessToken.trim();

  return {
    ...account,
    runtimeToken: nextRuntimeToken,
    notificationAuthToken: hasCustomNotificationToken
      ? account.notificationAuthToken
      : nextRuntimeToken
  };
}

export function buildStoredCredentialsFromAccount(
  account: ClawBondAccount
): ClawBondStoredCredentials | null {
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
    return null;
  }

  return credentials;
}
