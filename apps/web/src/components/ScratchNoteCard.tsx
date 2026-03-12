import { memo, useCallback, useRef, useState } from "react";
import { PencilIcon, Trash2Icon, CheckIcon } from "lucide-react";

import type { ScratchNote } from "../scratchNotes";
import { Button } from "./ui/button";
import ChatMarkdown from "./ChatMarkdown";

interface ScratchNoteCardProps {
  note: ScratchNote;
  onUpdate: (noteId: string, patch: { content?: string; annotation?: string }) => void;
  onDelete: (noteId: string) => void;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default memo(function ScratchNoteCard({ note, onUpdate, onDelete }: ScratchNoteCardProps) {
  if (note.kind === "freeform") {
    return <FreeformNoteCard note={note} onUpdate={onUpdate} onDelete={onDelete} />;
  }
  return <PinnedMessageCard note={note} onUpdate={onUpdate} onDelete={onDelete} />;
});

// ---------------------------------------------------------------------------
// Freeform note
// ---------------------------------------------------------------------------

function FreeformNoteCard({
  note,
  onUpdate,
  onDelete,
}: {
  note: Extract<ScratchNote, { kind: "freeform" }>;
  onUpdate: ScratchNoteCardProps["onUpdate"];
  onDelete: ScratchNoteCardProps["onDelete"];
}) {
  const [editing, setEditing] = useState(!note.content);
  const [draft, setDraft] = useState(note.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const save = useCallback(() => {
    onUpdate(note.id, { content: draft });
    setEditing(false);
  }, [note.id, draft, onUpdate]);

  return (
    <div className="group/card rounded-lg border border-border bg-background p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground/50">
          {formatRelativeTime(note.updatedAt)}
        </span>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/card:opacity-100">
          {!editing && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(note.content);
                setEditing(true);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              title="Edit note"
            >
              <PencilIcon className="size-3" />
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onDelete(note.id)}
            title="Delete note"
          >
            <Trash2Icon className="size-3" />
          </Button>
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            ref={textareaRef}
            className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(note.content);
                setEditing(false);
              }
            }}
            placeholder="Write markdown notes..."
            autoFocus
          />
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                setDraft(note.content);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={save}>
              <CheckIcon className="size-3" />
              Save
            </Button>
          </div>
        </div>
      ) : note.content ? (
        <div className="prose-xs">
          <ChatMarkdown text={note.content} cwd={undefined} />
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground/50">Empty note</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pinned message
// ---------------------------------------------------------------------------

function PinnedMessageCard({
  note,
  onUpdate,
  onDelete,
}: {
  note: Extract<ScratchNote, { kind: "pinned-message" }>;
  onUpdate: ScratchNoteCardProps["onUpdate"];
  onDelete: ScratchNoteCardProps["onDelete"];
}) {
  const [editingAnnotation, setEditingAnnotation] = useState(false);
  const [draft, setDraft] = useState(note.annotation);

  const save = useCallback(() => {
    onUpdate(note.id, { annotation: draft });
    setEditingAnnotation(false);
  }, [note.id, draft, onUpdate]);

  return (
    <div className="group/card rounded-lg border border-border bg-background p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground/50">
          Pinned from{" "}
          <span className="font-medium text-muted-foreground/70">
            {note.sourceThreadTitle || "thread"}
          </span>
          {" \u00b7 "}
          {formatRelativeTime(note.createdAt)}
        </span>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/card:opacity-100">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onDelete(note.id)}
            title="Unpin"
          >
            <Trash2Icon className="size-3" />
          </Button>
        </div>
      </div>

      <div className="rounded-md border-l-2 border-muted-foreground/25 bg-muted/40 px-3 py-2">
        <ChatMarkdown text={note.snapshotText} cwd={undefined} />
      </div>

      {editingAnnotation ? (
        <div className="mt-2 space-y-2">
          <textarea
            className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(note.annotation);
                setEditingAnnotation(false);
              }
            }}
            placeholder="Add a note..."
            autoFocus
          />
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                setDraft(note.annotation);
                setEditingAnnotation(false);
              }}
            >
              Cancel
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={save}>
              <CheckIcon className="size-3" />
              Save
            </Button>
          </div>
        </div>
      ) : note.annotation ? (
        <button
          type="button"
          className="mt-2 w-full cursor-pointer text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            setDraft(note.annotation);
            setEditingAnnotation(true);
          }}
        >
          {note.annotation}
        </button>
      ) : (
        <button
          type="button"
          className="mt-2 w-full cursor-pointer text-left text-[10px] italic text-muted-foreground/40 hover:text-muted-foreground/70"
          onClick={() => {
            setDraft("");
            setEditingAnnotation(true);
          }}
        >
          Add annotation...
        </button>
      )}
    </div>
  );
}
