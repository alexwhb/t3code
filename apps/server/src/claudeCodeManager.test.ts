import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { type ProviderEvent, ThreadId } from "@t3tools/contracts";
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

    const spawnProcess =
      vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>;
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
      images: [
        { mediaType: "image/png", base64Data: "iVBOR..." },
      ],
    });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  it("emits item/plan/proposed when assistant response contains EnterPlanMode tool", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess:
        vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
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
            { type: "text", text: "Let me create a plan." },
            { type: "tool_use", id: "tool-1", name: "EnterPlanMode", input: {} },
            { type: "text", text: "## Implementation Plan\n\n1. First step\n2. Second step\n3. Third step" },
            { type: "tool_use", id: "tool-2", name: "ExitPlanMode", input: {} },
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
      spawnProcess:
        vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
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
          content: [
            { type: "text", text: "Hello! How can I help?" },
          ],
        },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent).toBeUndefined();
  });

  it("emits item/plan/proposed from full assistant text when interactionMode is plan and no tool blocks", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess:
        vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
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
    expect(planEvent).toBeDefined();
    expect(planEvent?.payload).toEqual({
      planMarkdown: "## Refactor Plan\n\n1. Extract shared logic\n2. Add tests",
    });
  });

  it("does not emit plan event for plain text when interactionMode is default", async () => {
    const child = makeFakeChildProcess();
    const manager = new ClaudeCodeManager({
      spawnProcess:
        vi.fn(() => child) as NonNullable<ClaudeCodeManagerOptions["spawnProcess"]>,
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
          content: [
            { type: "text", text: "Hi there, how can I help?" },
          ],
        },
      })}\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const planEvent = events.find((e) => e.method === "item/plan/proposed");
    expect(planEvent).toBeUndefined();
  });
});
