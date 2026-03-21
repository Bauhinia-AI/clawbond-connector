import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";

import { clawbondPlugin } from "../src/channel.ts";
import { resolveAccount } from "../src/config.ts";
import { DEFAULT_STRUCTURED_MESSAGE_PREFIX } from "../src/message-envelope.ts";
import { setClawBondRuntime } from "../src/runtime.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-structured-message-e2e-"));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");

  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test WebSocket address");
  }

  const trustedContent =
    `${DEFAULT_STRUCTURED_MESSAGE_PREFIX}\n` +
    JSON.stringify({
      type: "learn.push",
      taskId: "learn_001",
      title: "One-click learning",
      body: "Read the suggested post and draft a concise learning note.",
      payload: {
        postId: "post_123",
        source: "rec_sys"
      }
    });
  const untrustedContent =
    `${DEFAULT_STRUCTURED_MESSAGE_PREFIX}\n` +
    JSON.stringify({
      type: "learn.push",
      taskId: "learn_999",
      body: "This should stay plain because the sender is not trusted."
    });

  const receivedFromPlugin: Array<{ to_agent_id: string; content: string }> = [];
  const inboundContexts: Array<Record<string, unknown>> = [];
  let latestStatus: Record<string, unknown> = { accountId: "default" };

  const connectionPromise = new Promise<void>((resolve, reject) => {
    wss.once("connection", (socket, req) => {
      try {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        assert.equal(requestUrl.pathname, "/ws");
        assert.equal(requestUrl.searchParams.get("token"), "rt_test");
      } catch (error) {
        reject(error);
        return;
      }

      socket.on("message", (data) => {
        receivedFromPlugin.push(JSON.parse(data.toString()) as { to_agent_id: string; content: string });
        if (receivedFromPlugin.length >= 2) {
          resolve();
        }
      });

      socket.send(
        JSON.stringify({
          event: "message",
          from_agent_id: "agent-rec-sys",
          content: trustedContent,
          timestamp: "2026-03-18T09:00:00.000Z"
        }),
      );

      socket.send(
        JSON.stringify({
          event: "message",
          from_agent_id: "agent-untrusted",
          content: untrustedContent,
          timestamp: "2026-03-18T09:00:01.000Z"
        }),
      );
    });
  });

  const cfg = {
    channels: {
      clawbond: {
        enabled: true,
        serverUrl: `http://127.0.0.1:${address.port}/ws`,
        stateRoot,
        bootstrapEnabled: false,
        runtimeToken: "rt_test",
        agentId: "agent-local",
        trustedSenderAgentIds: ["agent-rec-sys"]
      }
    }
  };

  const account = resolveAccount(cfg, "default");
  const stubChannelRuntime = {
    routing: {
      resolveAgentRoute: ({ peer }: { peer: { id: string } }) => ({
        agentId: "local-openclaw-agent",
        sessionKey: `channel:clawbond:peer:${peer.id}`
      })
    },
    session: {
      resolveStorePath: () => "/tmp/clawbond-structured-message-e2e",
      readSessionUpdatedAt: () => undefined,
      recordInboundSession: async ({ ctx }: { ctx: Record<string, unknown> }) => {
        inboundContexts.push(ctx);
      }
    },
    reply: {
      finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
      resolveEnvelopeFormatOptions: () => undefined,
      formatAgentEnvelope: ({ body }: { body: string }) => body,
      dispatchReplyWithBufferedBlockDispatcher: async ({
        ctx,
        dispatcherOptions
      }: {
        ctx: Record<string, unknown>;
        dispatcherOptions: { deliver: (payload: { text: string }) => Promise<void> };
      }) => {
        const bodyForAgent = String(ctx.BodyForAgent ?? "");
        const classification = bodyForAgent.includes("ClawBond platform event")
          ? "structured"
          : "plain";

        await dispatcherOptions.deliver({
          text: `ACK:${classification}`
        });
      }
    }
  };

  setClawBondRuntime({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    channel: stubChannelRuntime
  });

  const abortController = new AbortController();
  const runPromise = clawbondPlugin.gateway?.startAccount?.({
    cfg,
    accountId: account.accountId,
    account,
    abortSignal: abortController.signal,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    },
    channelRuntime: stubChannelRuntime,
    getStatus: () => latestStatus,
    setStatus: (next) => {
      latestStatus = { ...next };
    }
  });

  if (!runPromise) {
    throw new Error("clawbondPlugin.gateway.startAccount is unavailable");
  }

  try {
    await connectionPromise;

    assert.equal(inboundContexts.length, 2);
    assert.equal(receivedFromPlugin.length, 2);

    const repliesByTarget = new Map(
      receivedFromPlugin.map((entry) => [entry.to_agent_id, entry.content])
    );
    assert.equal(repliesByTarget.get("agent-rec-sys"), "ACK:structured");
    assert.equal(repliesByTarget.get("agent-untrusted"), "ACK:plain");

    const trustedContext =
      inboundContexts.find((entry) => entry.RawBody === trustedContent) ?? {};
    assert.equal(trustedContext.RawBody, trustedContent);
    assert.match(String(trustedContext.BodyForAgent ?? ""), /ClawBond platform event/);
    assert.match(String(trustedContext.BodyForAgent ?? ""), /Type: learn\.push/);
    assert.match(String(trustedContext.BodyForAgent ?? ""), /Task ID: learn_001/);
    assert.match(String(trustedContext.BodyForAgent ?? ""), /Payload JSON:/);

    const untrustedContext =
      inboundContexts.find((entry) => entry.RawBody === untrustedContent) ?? {};
    assert.equal(untrustedContext.RawBody, untrustedContent);
    assert.equal(untrustedContext.BodyForAgent, untrustedContent);
    assert.equal(typeof latestStatus.lastOutboundAt, "number");

    console.log("structured-message E2E passed");
  } finally {
    abortController.abort();
    await runPromise;
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
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

await main();
