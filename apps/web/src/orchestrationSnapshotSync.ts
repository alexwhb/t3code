import type { OrchestrationEvent, OrchestrationReadModel } from "@t3tools/contracts";

type OrchestrationApi = {
  getSnapshot: () => Promise<OrchestrationReadModel>;
  replayEvents: (
    fromSequenceExclusive: number,
  ) => Promise<ReadonlyArray<Pick<OrchestrationEvent, "sequence">>>;
};

interface LoadCaughtUpSnapshotOptions {
  readonly api: OrchestrationApi;
  readonly readLatestSequence: () => number;
  readonly writeLatestSequence: (sequence: number) => void;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly retryDelaysMs?: ReadonlyArray<number>;
}

const DEFAULT_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_000] as const;

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function loadCaughtUpSnapshot({
  api,
  readLatestSequence,
  writeLatestSequence,
  sleep = defaultSleep,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
}: LoadCaughtUpSnapshotOptions): Promise<OrchestrationReadModel> {
  let replayChecked = false;
  let lastSnapshot: OrchestrationReadModel | null = null;
  const replayEligible = readLatestSequence() === 0;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const snapshot = await api.getSnapshot();
    lastSnapshot = snapshot;

    let requiredSequence = Math.max(snapshot.snapshotSequence, readLatestSequence());

    // On reconnect or HMR remount we may have missed pushes while unsubscribed.
    // Replay from the snapshot fence once to discover whether the server has
    // already persisted newer orchestration events that the client has not seen.
    if (replayEligible && !replayChecked && requiredSequence === snapshot.snapshotSequence) {
      replayChecked = true;
      const replayedEvents = await api.replayEvents(snapshot.snapshotSequence);
      const replayedSequence =
        replayedEvents.length > 0
          ? (replayedEvents[replayedEvents.length - 1]?.sequence ?? snapshot.snapshotSequence)
          : snapshot.snapshotSequence;
      writeLatestSequence(replayedSequence);
      requiredSequence = Math.max(requiredSequence, readLatestSequence(), replayedSequence);
    }

    if (snapshot.snapshotSequence >= requiredSequence) {
      writeLatestSequence(snapshot.snapshotSequence);
      return snapshot;
    }

    const retryDelayMs = retryDelaysMs[attempt];
    if (retryDelayMs === undefined) {
      break;
    }
    await sleep(retryDelayMs);
  }

  if (!lastSnapshot) {
    return api.getSnapshot();
  }
  return lastSnapshot;
}
