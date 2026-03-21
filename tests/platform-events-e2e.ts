import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { WebSocketServer } from "ws";

import { PlatformClient } from "../src/platform-client.ts";
import type { ClawBondInvokeMessage } from "../src/types.ts";

async function main() {
  const received: ClawBondInvokeMessage[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    assert.equal(url.searchParams.get("token"), "rt_test");
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  const client = new PlatformClient({
    accountId: "default",
    enabled: true,
    configured: true,
    serverUrl: `http://127.0.0.1:${address.port}`,
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    socialBaseUrl: "",
    stateRoot: "/tmp/clawbond-platform-events-e2e",
    bootstrapEnabled: false,
    connectorToken: "",
    runtimeToken: "rt_test",
    agentId: "agent-local",
    agentName: "Local Agent",
    agentPersona: "",
    agentBio: "",
    agentTags: [],
    agentLanguage: "zh",
    secretKey: "secret-test",
    bindCode: "",
    ownerUserId: "user-1",
    bindingStatus: "bound",
    inviteWebBaseUrl: "",
    trustedSenderAgentIds: [],
    structuredMessagePrefix: "[CLAWBOND]",
    notificationsEnabled: true,
    notificationApiUrl: `http://127.0.0.1:${address.port}`,
    notificationAuthToken: "rt_test",
    notificationPollIntervalMs: 10000,
    bindStatusPollIntervalMs: 5000,
    channel: "clawbond"
  });

  client.on("invoke", (message) => {
    received.push(message);
  });

  const connected = new Promise<void>((resolve) => {
    wss.once("connection", (ws) => {
      ws.send(
        JSON.stringify({
          event: "connection_request",
          request_id: "req-1001",
          conversation_id: "conv-1001",
          from_agent_id: "agent-peer",
          message: "感觉我们主人适合认识一下",
          status: "pending"
        })
      );
      ws.send(
        JSON.stringify({
          event: "connection_request_response",
          request_id: "req-1002",
          conversation_id: "conv-1002",
          from_agent_id: "agent-peer-2",
          message: "这次先不约了",
          status: "rejected"
        })
      );
      resolve();
    });
  });

  try {
    await client.start();
    await connected;
    await waitFor(() => received.length === 2, 5000);

    assert.equal(received[0]?.sourceKind, "connection_request");
    assert.equal(received[0]?.structuredEnvelope?.kind, "connection_request");
    assert.match(received[0]?.prompt ?? "", /human introduction/);
    assert.match(received[0]?.prompt ?? "", /req-1001/);
    assert.equal(received[0]?.conversationId, "conv-1001");
    assert.equal(received[0]?.sourceAgentId, "agent-peer");

    assert.equal(received[1]?.sourceKind, "connection_request_response");
    assert.equal(received[1]?.structuredEnvelope?.kind, "connection_request_response");
    assert.match(received[1]?.prompt ?? "", /rejected/);
    assert.match(received[1]?.prompt ?? "", /req-1002/);
    assert.equal(received[1]?.conversationId, "conv-1002");
    assert.equal(received[1]?.sourceAgentId, "agent-peer-2");

    console.log("platform-events E2E passed");
  } finally {
    await client.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for platform events"));
        return;
      }

      setTimeout(tick, 25);
    };

    tick();
  });
}

await main();
