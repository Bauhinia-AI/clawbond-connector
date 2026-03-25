import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { ClawBondToolSession } from "../src/clawbond-api.ts";
import { CredentialStore } from "../src/credential-store.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-tool-session-refresh-e2e-"));
  const refreshBodies: Array<{ agent_id?: string; secret_key?: string }> = [];
  const refreshedToken = "agent_jwt_refreshed";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api/auth/agent/refresh") {
      const body = (await readJsonBody(req)) as { agent_id?: string; secret_key?: string };
      refreshBodies.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          data: { access_token: refreshedToken },
          message: "success"
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 404, data: null, message: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve tool-session-refresh test server address");
  }

  const serverUrl = `http://127.0.0.1:${address.port}`;
  const store = new CredentialStore(stateRoot);

  try {
    await store.save("default", {
      platform_base_url: serverUrl,
      agent_access_token: "",
      agent_id: "agent_3001",
      agent_name: "Tool Refresh QA",
      secret_key: "secret_3001",
      binding_status: "bound"
    });

    const cfgWithoutOverride = {
      channels: {
        clawbond: {
          enabled: true,
          serverUrl,
          stateRoot,
          bootstrapEnabled: false,
          agentId: "agent_3001",
          agentName: "Tool Refresh QA",
          secretKey: "secret_3001",
          bindingStatus: "bound"
        }
      }
    };

    const session = new ClawBondToolSession(cfgWithoutOverride, "default");
    const firstToken = await session.withAgentToken("refresh test", async (token) => token);
    assert.equal(firstToken, refreshedToken);
    assert.equal(session.account.runtimeToken, refreshedToken);
    assert.equal(session.account.notificationAuthToken, refreshedToken);

    const storedAfterRefresh = store.loadSync("default");
    assert.equal(storedAfterRefresh?.credentials.agent_access_token, refreshedToken);

    const cfgWithOverride = {
      channels: {
        clawbond: {
          ...cfgWithoutOverride.channels.clawbond,
          notificationAuthToken: "custom_notification_token"
        }
      }
    };

    const overrideSession = new ClawBondToolSession(cfgWithOverride, "default");
    overrideSession.account = {
      ...overrideSession.account,
      runtimeToken: "",
      notificationAuthToken: "custom_notification_token"
    };

    const secondToken = await overrideSession.withAgentToken("refresh override test", async (token) => token);
    assert.equal(secondToken, refreshedToken);
    assert.equal(overrideSession.account.runtimeToken, refreshedToken);
    assert.equal(overrideSession.account.notificationAuthToken, "custom_notification_token");

    assert.deepEqual(refreshBodies, [
      { agent_id: "agent_3001", secret_key: "secret_3001" },
      { agent_id: "agent_3001", secret_key: "secret_3001" }
    ]);

    console.log("tool-session-refresh E2E passed");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function readJsonBody(req: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

await main();
