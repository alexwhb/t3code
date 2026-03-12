import { memo, useCallback, useRef, useState } from "react";
import { CheckIcon, PencilIcon, Trash2Icon } from "lucide-react";

import type { ScratchTodo } from "../scratchNotes";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

interface ScratchTodoCardProps {
  todo: ScratchTodo;
  onUpdate: (todoId: string, patch: { content?: string; completed?: boolean }) => void;
  onDelete: (todoId: string) => void;
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

export default memo(function ScratchTodoCard({ todo, onUpdate, onDelete }: ScratchTodoCardProps) {
  const [editing, setEditing] = useState(!todo.content);
  const [draft, setDraft] = useState(todo.content);
  const inputRef = useRef<HTMLInputElement>(null);

  const save = useCallback(() => {
    onUpdate(todo.id, { content: draft });
    setEditing(false);
  }, [draft, onUpdate, todo.id]);

  return (
    <div className="group/card rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-3">
        <Checkbox
          aria-label={todo.completed ? "Mark to-do as incomplete" : "Mark to-do as complete"}
          checked={todo.completed}
          className="mt-0.5"
          onCheckedChange={(checked) => onUpdate(todo.id, { completed: checked === true })}
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground/50">
              {todo.completed && todo.completedAt
                ? `Completed ${formatRelativeTime(todo.completedAt)}`
                : `Updated ${formatRelativeTime(todo.updatedAt)}`}
            </span>
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/card:opacity-100">
              {!editing && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setDraft(todo.content);
                    setEditing(true);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  title="Edit to-do"
                >
                  <PencilIcon className="size-3" />
                </Button>
              )}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => onDelete(todo.id)}
                title="Delete to-do"
              >
                <Trash2Icon className="size-3" />
              </Button>
            </div>
          </div>

          {editing ? (
            <div className="space-y-2">
              <input
                ref={inputRef}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    save();
                  }
                  if (event.key === "Escape") {
                    setDraft(todo.content);
                    setEditing(false);
                  }
                }}
                placeholder="Add a to-do..."
                autoFocus
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setDraft(todo.content);
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
          ) : todo.content ? (
            <button
              type="button"
              className="w-full cursor-pointer text-left"
              onClick={() => {
                setDraft(todo.content);
                setEditing(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              <span
                className={
                  todo.completed
                    ? "text-sm text-muted-foreground line-through"
                    : "text-sm text-foreground"
                }
              >
                {todo.content}
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="w-full cursor-pointer text-left text-xs italic text-muted-foreground/50"
              onClick={() => {
                setDraft("");
                setEditing(true);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              Empty to-do
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
