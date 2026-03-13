import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { type ProviderEvent, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildClaudeArgs,
  ClaudeCodeManager,
  type ClaudeCodeManagerOptions,
  detectsFollowUpPromise,
} from "./claudeCodeManager";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSpawnSyncSuccess(): NonNullable<ClaudeCodeManagerOptions["spawnSyncProcess"]> {
  return vi.fn(() => ({
    pid: 1,
    output: [],
    stdout: "2.1.70 (Claude Code)",
    stderr: "",
    status: 0,
    signal: null,
  })) as NonNullable<ClaudeCodeManagerOptions["spawnSyncProcess"]>;
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
    const args = buildClaudeArgs({
      model: "sonnet",
      runtimeMode: "full-access",
      prompt: "Reply with OK",
    });
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--print");
    expect(args).toContain("Reply with OK");
  });

  it("includes --append-system-prompt for one-shot mode instruction", () => {
    const args = buildClaudeArgs({
      model: "sonnet",
      runtimeMode: "full-access",
      prompt: "Hello",
    });
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toContain("one-shot mode");
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

  it("uses stream-json input when hasImages is true", () => {
    const args = buildClaudeArgs({
      model: "sonnet",
      runtimeMode: "full-access",
      prompt: "Describe this image",
      hasImages: true,
    });

    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--print");
    // Prompt should NOT be passed as a CLI arg when using stream-json input
    expect(args).not.toContain("Describe this image");
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

describe("detectsFollowUpPromise", () => {
  it("returns true when Claude promises to follow up", () => {
    expect(detectsFollowUpPromise("I'll let you know when the deployment is done.")).toBe(true);
    expect(detectsFollowUpPromise("I will check back once it's finished.")).toBe(true);
    expect(detectsFollowUpPromise("I'll follow up when it's ready.")).toBe(true);
    expect(detectsFollowUpPromise("I'll keep you posted on the progress.")).toBe(true);
    expect(detectsFollowUpPromise("Waiting for the build to finish.")).toBe(true);
  });

  it("returns false for normal completions", () => {
    expect(detectsFollowUpPromise("The deployment completed successfully.")).toBe(false);
    expect(detectsFollowUpPromise("Here are the results of the build.")).toBe(false);
    expect(detectsFollowUpPromise("Done! The changes have been deployed.")).toBe(false);
  });

  it("only inspects the tail of the response", () => {
    const longPrefix = "Some earlier text. ".repeat(120); // ~2280 chars
    // Pattern buried far from the end should not trigger.
    expect(detectsFollowUpPromise("I'll let you know when it's done. " + longPrefix)).toBe(false);
    // Pattern near the end should trigger.
    expect(detectsFollowUpPromise(longPrefix + " I'll let you know when it's done.")).toBe(true);
  });
});

describe("ClaudeCodeManager", () => {
  it("closes stdin after spawning a print-mode turn", async () => {
    const child = makeFakeChildProcess();
    const spawnProcess = vi.fn(() => child) as NonNullable<
      ClaudeCodeManagerOptions["spawnProcess"]
    >;
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

  it("writes structured content blocks to stdin when images are provided", async () => {
    const child = makeFakeChildProcess();
    const stdinChunks: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => {
      stdinChunks.push(chunk.toString());
    });
    const originalWrite = child.stdin.write.bind(child.stdin);
    vi.spyOn(child.stdin, "write").mockImplementation(((data: unknown) => {
      stdinChunks.push(String(data));
      return originalWrite(data);
    }) as typeof child.stdin.write);

    const spawnProcess = vi.fn(() => child) as NonNullable<
      ClaudeCodeManagerOptions["spawnProcess"]
    >;
    const manager = new ClaudeCodeManager({
      spawnProcess,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-image-stdin");

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "What is in this image?",
      images: [{ mediaType: "image/png", base64Data: "iVBOR..." }],
    });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const args = (spawnProcess as any).mock.calls[0]![1] as string[];
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");

    expect(stdinChunks.length).toBeGreaterThan(0);
    const written = stdinChunks.join("").trim();
    // The message is newline-delimited JSON — parse the first line
    const firstLine = written.split("\n")[0]!;
    const parsed = JSON.parse(firstLine);
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toEqual([
      { type: "text", text: "What is in this image?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
      },
    ]);
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("keeps the logical session ready after a successful turn process exits", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
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

    child.stdout.write(`${JSON.stringify({ type: "system", session_id: "session-123" })}\n`);
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

  it("does not persist a resume cursor before Claude finishes successfully", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-pending-resume");

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "Reply with OK",
    });

    child.stdout.write(`${JSON.stringify({ type: "system", session_id: "session-123" })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        session_id: "session-123",
        message: {
          id: "msg-1",
          content: [{ type: "text", text: "OK" }],
        },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.listSessions()).toEqual([
      expect.not.objectContaining({
        resumeCursor: { conversationId: "session-123" },
      }),
    ]);
  });

  it("emits item/plan/proposed when assistant response contains ExitPlanMode with a plan", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-plan-mode");
    const events: ProviderEvent[] = [];

    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "Plan the implementation",
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-plan-1",
          content: [
            { type: "tool_use", id: "tool-1", name: "EnterPlanMode", input: {} },
            {
              type: "tool_use",
              id: "tool-2",
              name: "ExitPlanMode",
              input: {
                plan: "## Implementation Plan\n\n1. First step\n2. Second step\n3. Third step",
              },
            },
            { type: "text", text: "Shall I proceed?" },
          ],
        },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent).toBeDefined();
    expect(planEvent?.payload).toEqual({
      planMarkdown: "## Implementation Plan\n\n1. First step\n2. Second step\n3. Third step",
    });
  });

  it("does not emit plan event when no plan tools are present", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-no-plan");
    const events: ProviderEvent[] = [];

    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "Hello",
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-no-plan",
          content: [{ type: "text", text: "Hello! How can I help?" }],
        },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent).toBeUndefined();
  });

  it("does not emit plan event from plain assistant text when interactionMode is plan", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-plan-fallback");
    const events: ProviderEvent[] = [];

    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    // Send turn with interactionMode: "plan" — no tool blocks in response
    await manager.sendTurn({
      threadId,
      input: "Plan the refactor",
      interactionMode: "plan",
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-plan-fallback",
          content: [
            { type: "text", text: "## Refactor Plan\n\n1. Extract shared logic\n2. Add tests" },
          ],
        },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent).toBeUndefined();
  });

  it("does not emit plan event when Claude asks a follow-up question in plan mode", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-plan-question");
    const events: ProviderEvent[] = [];

    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "What happens if we delete the thread?",
      interactionMode: "plan",
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-plan-question",
          content: [
            { type: "tool_use", id: "tool-1", name: "EnterPlanMode", input: {} },
            {
              type: "text",
              text: "The pinned note will not go away. It becomes orphaned.",
            },
            {
              type: "tool_use",
              id: "tool-2",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Which approach do you prefer?",
                    header: "Cleanup",
                    options: [
                      {
                        label: "Clean up on delete",
                        description: "Remove pinned notes when their source thread is deleted.",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent).toBeUndefined();
  });

  it("emits a fallback plan event for structured markdown written to .claude/plans", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-plan-file-fallback");
    const events: ProviderEvent[] = [];

    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.startSession({
      threadId,
      cwd: mkdtempSync(join(tmpdir(), "t3code-claude-plan-")),
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "Plan the refactor",
      interactionMode: "plan",
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-plan-file-fallback",
          content: [
            {
              type: "tool_use",
              id: "tool-write-plan",
              name: "Write",
              input: {
                file_path: ".claude/plans/refactor-plan.md",
                content: "## Refactor Plan\n\n1. Extract shared logic\n2. Add tests",
              },
            },
          ],
        },
      })}\n`,
    );
    child.stdout.write(`${JSON.stringify({ type: "result" })}\n`);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent?.payload).toEqual({
      planMarkdown: "## Refactor Plan\n\n1. Extract shared logic\n2. Add tests",
    });
  });

  it("does not emit a fallback plan event for unstructured text written to .claude/plans", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-plan-file-plain-text");
    const events: ProviderEvent[] = [];

    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.startSession({
      threadId,
      cwd: mkdtempSync(join(tmpdir(), "t3code-claude-plan-")),
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "Plan the refactor",
      interactionMode: "plan",
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-plan-file-plain-text",
          content: [
            {
              type: "tool_use",
              id: "tool-write-plan",
              name: "Write",
              input: {
                file_path: ".claude/plans/refactor-plan.md",
                content:
                  "Let me explore the existing patterns for data import/export and the current entitlement creation flow.",
              },
            },
          ],
        },
      })}\n`,
    );
    child.stdout.write(`${JSON.stringify({ type: "result" })}\n`);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent).toBeUndefined();
  });

  it("rejects overlapping turns instead of resuming an in-flight Claude session", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-overlapping-turns");

    await manager.startSession({ threadId, runtimeMode: "full-access" });
    await manager.sendTurn({ threadId, input: "Turn 1" });

    await expect(manager.sendTurn({ threadId, input: "Turn 2" })).rejects.toThrow(
      "Claude Code does not support overlapping turns.",
    );
  });

  it("clears a poisoned resume cursor after Claude reports that the session ID is invalid", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-invalid-resume");

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
      resumeCursor: { conversationId: "session-123" },
    });

    await manager.sendTurn({ threadId, input: "Retry the task" });

    child.stdout.write(
      `${JSON.stringify({
        type: "result",
        is_error: true,
        session_id: "failed-session",
        errors: ["No conversation found with session ID: session-123"],
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.listSessions()).toEqual([
      expect.objectContaining({
        threadId,
        status: "ready",
        resumeCursor: null,
      }),
    ]);
  });

  it("does not emit plan event for plain text when interactionMode is default", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess: vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
      spawnSyncProcess: makeSpawnSyncSuccess(),
    });
    const threadId = ThreadId.makeUnsafe("thread-default-no-plan");
    const events: ProviderEvent[] = [];

    manager.on("event", (event) => {
      events.push(event);
    });

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
    });

    await manager.sendTurn({
      threadId,
      input: "Hello",
      interactionMode: "default",
    });

    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-default",
          content: [{ type: "text", text: "Hi there, how can I help?" }],
        },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent).toBeUndefined();
  });
});
