import { describe, expect, it } from "vitest";

import { parseScratchWorkspaceData } from "./scratchNotes";

describe("parseScratchWorkspaceData", () => {
  it("migrates legacy note arrays into the notes bucket", () => {
    const legacyRaw = JSON.stringify([
      {
        id: "note-1",
        kind: "freeform",
        content: "hello",
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      },
    ]);

    expect(parseScratchWorkspaceData(legacyRaw)).toEqual({
      notes: [
        {
          id: "note-1",
          kind: "freeform",
          content: "hello",
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
        },
      ],
      todos: [],
    });
  });

  it("reads structured note and todo data", () => {
    const raw = JSON.stringify({
      notes: [
        {
          id: "note-1",
          kind: "pinned-message",
          sourceMessageId: "message-1",
          sourceThreadId: "thread-1",
          sourceThreadTitle: "Thread",
          snapshotText: "snapshot",
          annotation: "annotation",
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
        },
      ],
      todos: [
        {
          id: "todo-1",
          content: "ship tabbed todos",
          completed: false,
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
          completedAt: null,
        },
      ],
    });

    expect(parseScratchWorkspaceData(raw)).toEqual({
      notes: [
        {
          id: "note-1",
          kind: "pinned-message",
          sourceMessageId: "message-1",
          sourceThreadId: "thread-1",
          sourceThreadTitle: "Thread",
          snapshotText: "snapshot",
          annotation: "annotation",
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
        },
      ],
      todos: [
        {
          id: "todo-1",
          content: "ship tabbed todos",
          completed: false,
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
          completedAt: null,
        },
      ],
    });
  });
});
