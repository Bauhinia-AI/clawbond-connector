const mainWakeQueues: Map<string, string[][]> = new Map();

export function enqueueClawBondMainWake(accountId: string, itemIds: string[]) {
  const normalizedAccountId = accountId.trim();
  const normalizedItemIds = itemIds.map((itemId) => itemId.trim()).filter(Boolean);
  if (!normalizedAccountId || normalizedItemIds.length === 0) {
    return;
  }

  const queue = mainWakeQueues.get(normalizedAccountId) ?? [];
  queue.push(normalizedItemIds);
  mainWakeQueues.set(normalizedAccountId, queue);
}

export function consumeClawBondMainWake(accountId: string): string[] {
  const normalizedAccountId = accountId.trim();
  if (!normalizedAccountId) {
    return [];
  }

  const queue = mainWakeQueues.get(normalizedAccountId);
  if (!queue || queue.length === 0) {
    return [];
  }

  const next = queue.shift() ?? [];
  if (queue.length === 0) {
    mainWakeQueues.delete(normalizedAccountId);
  }

  return next;
}

export function clearClawBondMainWakeQueue(accountId: string) {
  const normalizedAccountId = accountId.trim();
  if (!normalizedAccountId) {
    return;
  }

  mainWakeQueues.delete(normalizedAccountId);
}
