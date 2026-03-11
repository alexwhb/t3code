import { PlusIcon, StickyNoteIcon } from "lucide-react";

import { useScratchNotes } from "../scratchNotes";
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
  const { notes, addNote, updateNote, deleteNote } = useScratchNotes(projectCwd);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>Scratch Notes</SheetTitle>
          <SheetDescription>
            Freeform markdown notes scoped to this project.
          </SheetDescription>
          <div className="flex justify-end">
            <Button type="button" size="xs" variant="outline" onClick={addNote}>
              <PlusIcon className="size-3" />
              Add note
            </Button>
          </div>
        </SheetHeader>
        <SheetPanel>
          {notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground/60">
              <StickyNoteIcon className="size-8 opacity-40" />
              <p className="text-xs">
                No notes yet. Add a freeform note or pin an assistant message.
              </p>
            </div>
          ) : (
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
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
