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

export interface ScratchTodo {
  id: string;
  content: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ScratchNote = FreeformNote | PinnedMessage;
export type ScratchNotesTab = "notes" | "todos";

export interface ScratchWorkspaceData {
  notes: readonly ScratchNote[];
  todos: readonly ScratchTodo[];
}

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
let cachedSnapshotByProject = new Map<string, ScratchWorkspaceData>();

const EMPTY_NOTES: readonly ScratchNote[] = [];
const EMPTY_TODOS: readonly ScratchTodo[] = [];
const EMPTY_WORKSPACE_DATA: ScratchWorkspaceData = {
  notes: EMPTY_NOTES,
  todos: EMPTY_TODOS,
};

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function parseScratchWorkspaceData(raw: string | null): ScratchWorkspaceData {
  if (!raw) return EMPTY_WORKSPACE_DATA;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        notes: parsed as ScratchNote[],
        todos: EMPTY_TODOS,
      };
    }
    if (parsed && typeof parsed === "object") {
      const workspaceData = parsed as Partial<ScratchWorkspaceData>;
      return {
        notes: Array.isArray(workspaceData.notes) ? workspaceData.notes : EMPTY_NOTES,
        todos: Array.isArray(workspaceData.todos) ? workspaceData.todos : EMPTY_TODOS,
      };
    }
    return EMPTY_WORKSPACE_DATA;
  } catch {
    return EMPTY_WORKSPACE_DATA;
  }
}

function getNotesSnapshot(projectCwd: string | null): ScratchWorkspaceData {
  if (typeof window === "undefined" || !projectCwd) return EMPTY_WORKSPACE_DATA;

  const key = storageKey(projectCwd);
  const raw = window.localStorage.getItem(key);

  if (raw === cachedRawByProject.get(projectCwd)) {
    return cachedSnapshotByProject.get(projectCwd) ?? EMPTY_WORKSPACE_DATA;
  }

  const notes = parseScratchWorkspaceData(raw);
  cachedRawByProject.set(projectCwd, raw);
  cachedSnapshotByProject.set(projectCwd, notes);
  return notes;
}

function persistNotes(projectCwd: string, notes: ScratchWorkspaceData): void {
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
  const workspaceData = useSyncExternalStore(
    subscribe,
    () => getNotesSnapshot(projectCwd),
    () => EMPTY_WORKSPACE_DATA,
  );
  const { notes, todos } = workspaceData;

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
    persistNotes(projectCwd, {
      ...current,
      notes: [note, ...current.notes],
    });
    emitChange();
  }, [projectCwd]);

  const addTodo = useCallback(() => {
    if (!projectCwd) return;
    const now = new Date().toISOString();
    const todo: ScratchTodo = {
      id: crypto.randomUUID(),
      content: "",
      completed: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const current = getNotesSnapshot(projectCwd);
    persistNotes(projectCwd, {
      ...current,
      todos: [todo, ...current.todos],
    });
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
      persistNotes(projectCwd, {
        ...current,
        notes: [note, ...current.notes],
      });
      emitChange();
    },
    [projectCwd],
  );

  const updateNote = useCallback(
    (noteId: string, patch: { content?: string; annotation?: string }) => {
      if (!projectCwd) return;
      const current = getNotesSnapshot(projectCwd);
      const updated = current.notes.map((note) => {
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
      persistNotes(projectCwd, {
        ...current,
        notes: updated,
      });
      emitChange();
    },
    [projectCwd],
  );

  const updateTodo = useCallback(
    (todoId: string, patch: { content?: string; completed?: boolean }) => {
      if (!projectCwd) return;
      const current = getNotesSnapshot(projectCwd);
      const updated = current.todos.map((todo) => {
        if (todo.id !== todoId) return todo;
        const now = new Date().toISOString();
        const completed = patch.completed ?? todo.completed;
        return {
          ...todo,
          ...(patch.content !== undefined ? { content: patch.content } : {}),
          ...(patch.completed !== undefined ? { completed } : {}),
          completedAt: patch.completed !== undefined ? (completed ? now : null) : todo.completedAt,
          updatedAt: now,
        };
      });
      persistNotes(projectCwd, {
        ...current,
        todos: updated,
      });
      emitChange();
    },
    [projectCwd],
  );

  const deleteNote = useCallback(
    (noteId: string) => {
      if (!projectCwd) return;
      const current = getNotesSnapshot(projectCwd);
      persistNotes(projectCwd, {
        ...current,
        notes: current.notes.filter((note) => note.id !== noteId),
      });
      emitChange();
    },
    [projectCwd],
  );

  const deleteTodo = useCallback(
    (todoId: string) => {
      if (!projectCwd) return;
      const current = getNotesSnapshot(projectCwd);
      persistNotes(projectCwd, {
        ...current,
        todos: current.todos.filter((todo) => todo.id !== todoId),
      });
      emitChange();
    },
    [projectCwd],
  );

  return {
    notes,
    todos,
    addNote,
    addTodo,
    pinMessage,
    updateNote,
    updateTodo,
    deleteNote,
    deleteTodo,
  } as const;
}
