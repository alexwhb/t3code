interface OrchestrationSyncState {
  latestSequence: number;
}

const ORCHESTRATION_SYNC_STATE_KEY = "__t3codeOrchestrationSyncState";

type GlobalWithOrchestrationSyncState = typeof globalThis & {
  [ORCHESTRATION_SYNC_STATE_KEY]?: OrchestrationSyncState;
};

export function getOrchestrationSyncState(): OrchestrationSyncState {
  const scope = globalThis as GlobalWithOrchestrationSyncState;
  if (!scope[ORCHESTRATION_SYNC_STATE_KEY]) {
    scope[ORCHESTRATION_SYNC_STATE_KEY] = { latestSequence: 0 };
  }
  return scope[ORCHESTRATION_SYNC_STATE_KEY];
}
