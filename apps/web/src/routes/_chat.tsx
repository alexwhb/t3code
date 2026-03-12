import { Outlet, createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ThreadId } from "@t3tools/contracts";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import ScratchNotesSheet from "../components/ScratchNotesSheet";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH,
} from "~/components/ui/sidebar";
import { useStore } from "../store";
import { useScratchNotes } from "../scratchNotes";
import { ScratchNotesProvider } from "../scratchNotesContext";
import { resolveShortcutCommand } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";

const EMPTY_KEYBINDINGS: never[] = [];
const LEFT_SIDEBAR_MIN = SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH; // 256px
const LEFT_SIDEBAR_MAX = SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH * 3; // 768px
const MIN_MAIN_CONTENT_WIDTH = 480;

function ChatRouteLayout() {
  const navigate = useNavigate();
  const [scratchNotesOpen, setScratchNotesOpen] = useState(false);

  // Derive active project CWD from route params + store
  const routeThreadId = useParams({
    strict: false,
    select: (params: Record<string, string | undefined>) =>
      params.threadId ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const activeThread = routeThreadId ? threads.find((t) => t.id === routeThreadId) : null;
  const activeProject = activeThread ? projects.find((p) => p.id === activeThread.projectId) : null;
  const activeProjectCwd = activeProject?.cwd ?? null;

  const { pinMessage } = useScratchNotes(activeProjectCwd);

  const shouldAcceptLeftSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      return wrapper.clientWidth - nextWidth >= MIN_MAIN_CONTENT_WIDTH;
    },
    [],
  );

  const leftSidebarResizable = useMemo(
    () => ({
      minWidth: LEFT_SIDEBAR_MIN,
      maxWidth: LEFT_SIDEBAR_MAX,
      shouldAcceptWidth: shouldAcceptLeftSidebarWidth,
      storageKey: "chat_left_sidebar_width",
    }),
    [shouldAcceptLeftSidebarWidth],
  );

  const openSheet = useCallback(() => setScratchNotesOpen(true), []);

  // Keybinding: notes.toggle
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings);
      if (command === "notes.toggle") {
        event.preventDefault();
        event.stopPropagation();
        setScratchNotesOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [keybindings]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    <ScratchNotesProvider openSheet={openSheet} pinMessage={pinMessage}>
      <SidebarProvider defaultOpen>
        <Sidebar
          side="left"
          collapsible="offcanvas"
          resizable={leftSidebarResizable}
          className="border-r border-border bg-card text-foreground"
        >
          <ThreadSidebar />
          <SidebarRail />
        </Sidebar>
        <DiffWorkerPoolProvider>
          <Outlet />
        </DiffWorkerPoolProvider>
        <ScratchNotesSheet
          open={scratchNotesOpen}
          onOpenChange={setScratchNotesOpen}
          projectCwd={activeProjectCwd}
        />
      </SidebarProvider>
    </ScratchNotesProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
