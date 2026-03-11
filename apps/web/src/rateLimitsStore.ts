import { useSyncExternalStore } from "react";
import { onRateLimitsUpdated, type RateLimitsPayload } from "./wsNativeApi";

let current: RateLimitsPayload | null = null;
const listeners = new Set<() => void>();

let subscribed = false;
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  onRateLimitsUpdated((payload) => {
    current = payload;
    for (const listener of listeners) {
      listener();
    }
  });
}

function subscribe(onStoreChange: () => void): () => void {
  ensureSubscribed();
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): RateLimitsPayload | null {
  return current;
}

export function useRateLimits(): RateLimitsPayload | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
