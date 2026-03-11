import { useCallback, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FreeformNote {
  id: string;
  kind: "freeform";
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface PinnedMessage {
  id: string;
  kind: "pinned-message";
  sourceMessageId: string;
  sourceThreadId: string;
  sourceThreadTitle: string;
  snapshotText: string;
  annotation: string;
  createdAt: string;
  updatedAt: string;
}

export type ScratchNote = FreeformNote | PinnedMessage;

export interface PinMessageParams {
  messageId: string;
  threadId: string;
  threadTitle: string;
  snapshotText: string;
}

// ---------------------------------------------------------------------------
// Storage helpers (follows appSettings.ts pattern)
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = "t3code:scratch-notes:v1:";

function storageKey(projectCwd: string): string {
  return `${STORAGE_KEY_PREFIX}${projectCwd}`;
}

let listeners: Array<() => void> = [];
let cachedRawByProject = new Map<string, string | null>();
let cachedSnapshotByProject = new Map<string, readonly ScratchNote[]>();

const EMPTY_NOTES: readonly ScratchNote[] = [];

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parseNotes(raw: string | null): readonly ScratchNote[] {
  if (!raw) return EMPTY_NOTES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_NOTES;
    return parsed as ScratchNote[];
  } catch {
    return EMPTY_NOTES;
  }
}

function getNotesSnapshot(projectCwd: string | null): readonly ScratchNote[] {
  if (typeof window === "undefined" || !projectCwd) return EMPTY_NOTES;

  const key = storageKey(projectCwd);
  const raw = window.localStorage.getItem(key);

  if (raw === cachedRawByProject.get(projectCwd)) {
    return cachedSnapshotByProject.get(projectCwd) ?? EMPTY_NOTES;
  }

  const notes = parseNotes(raw);
  cachedRawByProject.set(projectCwd, raw);
  cachedSnapshotByProject.set(projectCwd, notes);
  return notes;
}

function persistNotes(projectCwd: string, notes: readonly ScratchNote[]): void {
  if (typeof window === "undefined") return;

  const key = storageKey(projectCwd);
  const raw = JSON.stringify(notes);
  try {
    window.localStorage.setItem(key, raw);
  } catch {
    // Best-effort persistence only.
  }
  cachedRawByProject.set(projectCwd, raw);
  cachedSnapshotByProject.set(projectCwd, notes);
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(STORAGE_KEY_PREFIX)) {
      // Invalidate cache for the affected project
      const projectCwd = event.key.slice(STORAGE_KEY_PREFIX.length);
      cachedRawByProject.delete(projectCwd);
      cachedSnapshotByProject.delete(projectCwd);
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MAX_SNAPSHOT_LENGTH = 2000;

export function useScratchNotes(projectCwd: string | null) {
  const notes = useSyncExternalStore(
    subscribe,
    () => getNotesSnapshot(projectCwd),
    () => EMPTY_NOTES,
  );

  const addNote = useCallback(() => {
    if (!projectCwd) return;
    const now = new Date().toISOString();
    const note: FreeformNote = {
      id: crypto.randomUUID(),
      kind: "freeform",
      content: "",
      createdAt: now,
      updatedAt: now,
    };
    const current = getNotesSnapshot(projectCwd);
    persistNotes(projectCwd, [note, ...current]);
    emitChange();
  }, [projectCwd]);

  const pinMessage = useCallback(
    (params: PinMessageParams) => {
      if (!projectCwd) return;
      const now = new Date().toISOString();
      const note: PinnedMessage = {
        id: crypto.randomUUID(),
        kind: "pinned-message",
        sourceMessageId: params.messageId,
        sourceThreadId: params.threadId,
        sourceThreadTitle: params.threadTitle,
        snapshotText: params.snapshotText.slice(0, MAX_SNAPSHOT_LENGTH),
        annotation: "",
        createdAt: now,
        updatedAt: now,
      };
      const current = getNotesSnapshot(projectCwd);
      persistNotes(projectCwd, [note, ...current]);
      emitChange();
    },
    [projectCwd],
  );

  const updateNote = useCallback(
    (noteId: string, patch: { content?: string; annotation?: string }) => {
      if (!projectCwd) return;
      const current = getNotesSnapshot(projectCwd);
      const updated = current.map((note) => {
        if (note.id !== noteId) return note;
        const now = new Date().toISOString();
        if (note.kind === "freeform" && patch.content !== undefined) {
          return { ...note, content: patch.content, updatedAt: now };
        }
        if (note.kind === "pinned-message" && patch.annotation !== undefined) {
          return { ...note, annotation: patch.annotation, updatedAt: now };
        }
        return note;
      });
      persistNotes(projectCwd, updated);
      emitChange();
    },
    [projectCwd],
  );

  const deleteNote = useCallback(
    (noteId: string) => {
      if (!projectCwd) return;
      const current = getNotesSnapshot(projectCwd);
      persistNotes(
        projectCwd,
        current.filter((note) => note.id !== noteId),
      );
      emitChange();
    },
    [projectCwd],
  );

  return { notes, addNote, pinMessage, updateNote, deleteNote } as const;
}
