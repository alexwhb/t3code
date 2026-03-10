import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildClaudeArgs,
  ClaudeCodeManager,
  type ClaudeCodeManagerOptions,
} from "./claudeCodeManager";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSpawnSyncSuccess(): NonNullable<ClaudeCodeManagerOptions["spawnSyncProcess"]> {
  return vi.fn(() =>
    ({
      pid: 1,
      output: [],
      stdout: "2.1.70 (Claude Code)",
      stderr: "",
      status: 0,
      signal: null,
    }),
  ) as NonNullable<ClaudeCodeManagerOptions["spawnSyncProcess"]>;
}

type FakeChildProcess = EventEmitter &
  ChildProcessWithoutNullStreams & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };

function makeFakeChildProcess(): FakeChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = new EventEmitter() as FakeChildProcess;

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    stdio: [stdin, stdout, stderr],
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnfile: "claude",
    spawnargs: [],
    pid: 1234,
    kill: vi.fn(() => true),
  });

  return child;
}

describe("buildClaudeArgs", () => {
  it("builds a print-mode stream-json invocation for a new turn", () => {
    expect(
      buildClaudeArgs({
        model: "sonnet",
        runtimeMode: "full-access",
        prompt: "Reply with OK",
      }),
    ).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
      "--print",
      "Reply with OK",
    ]);
  });

  it("resumes a specific conversation with --resume", () => {
    const args = buildClaudeArgs({
      model: "sonnet",
      runtimeMode: "approval-required",
      resumeCursor: { conversationId: "session-123" },
      prompt: "Follow up",
    });

    expect(args).toContain("--resume");
    expect(args).toContain("session-123");
    expect(args).not.toContain("--continue");
    expect(args).not.toContain("--conversation-id");
  });

  it("uses --permission-mode plan when interactionMode is plan", () => {
    const args = buildClaudeArgs({
      model: "sonnet",
      runtimeMode: "full-access",
      interactionMode: "plan",
      prompt: "Plan how to refactor this",
    });

    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    // Plan mode takes precedence over --dangerously-skip-permissions
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("does not add --permission-mode when interactionMode is default", () => {
    const args = buildClaudeArgs({
      model: "sonnet",
      runtimeMode: "full-access",
      interactionMode: "default",
      prompt: "Do something",
    });

    expect(args).not.toContain("--permission-mode");
    expect(args).toContain("--dangerously-skip-permissions");
  });
});

describe("ClaudeCodeManager", () => {
  it("closes stdin after spawning a print-mode turn", async () => {
    const child = makeFakeChildProcess();
    const spawnProcess =
      vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>;
    const manager = new ClaudeCodeManager({
      spawnProcess,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-stdin-close");

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "Reply with OK",
    });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("keeps the logical session ready after a successful turn process exits", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess:
        vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-successful-exit");
    const events: Array<{ method: string }> = [];

    manager.on("event", (event) => {
      events.push({ method: event.method });
    });

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "Reply with OK",
    });

    child.stdout.write(
      `${JSON.stringify({ type: "system", session_id: "session-123" })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          content: [{ type: "text", text: "OK" }],
        },
      })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: "result",
        session_id: "session-123",
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    child.emit("exit", 0, null);

    expect(manager.hasSession(threadId)).toBe(true);
    expect(manager.listSessions()).toEqual([
      expect.objectContaining({
        threadId,
        status: "ready",
        activeTurnId: undefined,
        resumeCursor: { conversationId: "session-123" },
      }),
    ]);
    expect(events.some((event) => event.method === "turn/completed")).toBe(true);
    expect(events.some((event) => event.method === "session/exited")).toBe(false);
  });
});
