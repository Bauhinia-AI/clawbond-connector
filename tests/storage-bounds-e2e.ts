import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ClawBondActivityStore } from "../src/activity-store.ts";
import { ClawBondInboxStore } from "../src/inbox-store.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-storage-bounds-e2e-"));
  const accountId = "default";
  const activityStore = new ClawBondActivityStore(stateRoot);
  const inboxStore = new ClawBondInboxStore(stateRoot);

  try {
    const largePreview = "x".repeat(700);
    for (let index = 0; index < 1200; index += 1) {
      await activityStore.append(accountId, {
        agentId: "agent-storage",
        sessionKey: "agent:main:main",
        event: "inbound_received",
        summary: `activity-${index}`,
        preview: largePreview
      });
    }

    const activityEntries = await activityStore.list(accountId, 2000);
    assert.equal(activityEntries.length, 1000);
    assert.equal(activityEntries[0]?.summary, "activity-200");
    assert.equal(activityEntries.at(-1)?.summary, "activity-1199");

    const activityFilePath = path.join(stateRoot, "activity", "default.jsonl");
    const activityLines = (await readFile(activityFilePath, "utf-8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    assert.equal(activityLines.length, 1000);

    for (let index = 0; index < 250; index += 1) {
      await inboxStore.enqueue(accountId, {
        fingerprint: `pending-${index}`,
        sourceKind: "message",
        peerId: `peer-${index}`,
        peerLabel: `peer-${index}`,
        summary: `pending-${index}`,
        content: `content-${index}`
      });
    }

    const pendingItems = await inboxStore.listPending(accountId, 500);
    assert.equal(pendingItems.length, 200);
    assert.equal(pendingItems[0]?.summary, "pending-50");
    assert.equal(pendingItems.at(-1)?.summary, "pending-249");
    assert.equal(await inboxStore.countPending(accountId), 200);

    console.log("storage-bounds E2E passed");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

await main();
