import { describe, expect, it, vi } from "vitest";
import type { OrchestrationReadModel } from "@t3tools/contracts";

import { loadCaughtUpSnapshot } from "./orchestrationSnapshotSync";

function makeSnapshot(snapshotSequence: number): OrchestrationReadModel {
  return {
    snapshotSequence,
    projects: [],
    threads: [],
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
}

describe("loadCaughtUpSnapshot", () => {
  it("returns the first snapshot when it is already caught up", async () => {
    let latestSequence = 0;
    const getSnapshot = vi.fn().mockResolvedValue(makeSnapshot(5));
    const replayEvents = vi.fn().mockResolvedValue([]);

    const snapshot = await loadCaughtUpSnapshot({
      api: { getSnapshot, replayEvents },
      readLatestSequence: () => latestSequence,
      writeLatestSequence: (sequence) => {
        latestSequence = Math.max(latestSequence, sequence);
      },
      sleep: async () => undefined,
    });

    expect(snapshot.snapshotSequence).toBe(5);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(replayEvents).toHaveBeenCalledWith(5);
    expect(latestSequence).toBe(5);
  });

  it("retries until the snapshot catches up to replayed events", async () => {
    let latestSequence = 0;
    const getSnapshot = vi
      .fn<() => Promise<OrchestrationReadModel>>()
      .mockResolvedValueOnce(makeSnapshot(10))
      .mockResolvedValueOnce(makeSnapshot(12));
    const replayEvents = vi.fn().mockResolvedValue([{ sequence: 12 }]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const snapshot = await loadCaughtUpSnapshot({
      api: { getSnapshot, replayEvents },
      readLatestSequence: () => latestSequence,
      writeLatestSequence: (sequence) => {
        latestSequence = Math.max(latestSequence, sequence);
      },
      sleep,
      retryDelaysMs: [1],
    });

    expect(snapshot.snapshotSequence).toBe(12);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(replayEvents).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(latestSequence).toBe(12);
  });

  it("retries until the snapshot catches up to the latest known sequence", async () => {
    let latestSequence = 20;
    const getSnapshot = vi
      .fn<() => Promise<OrchestrationReadModel>>()
      .mockResolvedValueOnce(makeSnapshot(18))
      .mockResolvedValueOnce(makeSnapshot(20));
    const replayEvents = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const snapshot = await loadCaughtUpSnapshot({
      api: { getSnapshot, replayEvents },
      readLatestSequence: () => latestSequence,
      writeLatestSequence: (sequence) => {
        latestSequence = Math.max(latestSequence, sequence);
      },
      sleep,
      retryDelaysMs: [1],
    });

    expect(snapshot.snapshotSequence).toBe(20);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(replayEvents).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(latestSequence).toBe(20);
  });
});
