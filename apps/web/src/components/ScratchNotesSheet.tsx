import { useState } from "react";
import { ListTodoIcon, PlusIcon, StickyNoteIcon } from "lucide-react";

import { type ScratchNotesTab, useScratchNotes } from "../scratchNotes";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetPanel,
} from "./ui/sheet";
import ScratchNoteCard from "./ScratchNoteCard";
import ScratchTodoCard from "./ScratchTodoCard";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

interface ScratchNotesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectCwd: string | null;
}

export default function ScratchNotesSheet({
  open,
  onOpenChange,
  projectCwd,
}: ScratchNotesSheetProps) {
  const { notes, todos, addNote, addTodo, updateNote, updateTodo, deleteNote, deleteTodo } =
    useScratchNotes(projectCwd);
  const [activeTab, setActiveTab] = useState<ScratchNotesTab>("notes");
  const emptyStateIcon =
    activeTab === "notes" ? (
      <StickyNoteIcon className="size-8 opacity-40" />
    ) : (
      <ListTodoIcon className="size-8 opacity-40" />
    );
  const emptyStateCopy =
    activeTab === "notes"
      ? "No notes yet. Add a freeform note or pin an assistant message."
      : "No to-dos yet. Add one to keep project tasks visible next to your notes.";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>Scratch Notes</SheetTitle>
          <SheetDescription>Project-scoped notes, pinned messages, and to-dos.</SheetDescription>
          <div className="flex items-center justify-between gap-2">
            <ToggleGroup
              aria-label="Scratch notes sections"
              size="xs"
              variant="outline"
              value={[activeTab]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "notes" || next === "todos") {
                  setActiveTab(next);
                }
              }}
            >
              <Toggle aria-label="Show notes" value="notes">
                Notes
              </Toggle>
              <Toggle aria-label="Show to-dos" value="todos">
                To-dos
              </Toggle>
            </ToggleGroup>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                if (activeTab === "notes") {
                  addNote();
                  return;
                }
                addTodo();
              }}
            >
              <PlusIcon className="size-3" />
              {activeTab === "notes" ? "Add note" : "Add to-do"}
            </Button>
          </div>
        </SheetHeader>
        <SheetPanel>
          {activeTab === "notes" && notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground/60">
              {emptyStateIcon}
              <p className="text-xs">{emptyStateCopy}</p>
            </div>
          ) : activeTab === "todos" && todos.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground/60">
              {emptyStateIcon}
              <p className="text-xs">{emptyStateCopy}</p>
            </div>
          ) : activeTab === "notes" ? (
            <div className="space-y-3">
              {notes.map((note) => (
                <ScratchNoteCard
                  key={note.id}
                  note={note}
                  onUpdate={updateNote}
                  onDelete={deleteNote}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {todos.map((todo) => (
                <ScratchTodoCard
                  key={todo.id}
                  todo={todo}
                  onUpdate={updateTodo}
                  onDelete={deleteTodo}
                />
              ))}
            </div>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
