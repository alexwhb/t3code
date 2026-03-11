import {
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

// ── Types ────────────────────────────────────────────────────────────

interface ClaudeCodeSessionContext {
  session: ProviderSession;
  child: ChildProcessWithoutNullStreams | null;
  output: readline.Interface | null;
  conversationId: string | null;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  stopping: boolean;
  currentTurnId: TurnId | null;
  currentInteractionMode: ProviderInteractionMode | null;
  assistantTextBuffer: string;
  binaryPath: string;
  /** Whether we're currently inside EnterPlanMode/ExitPlanMode boundaries (persists across assistant events). */
  planModeActive: boolean;
  /** Text collected between EnterPlanMode and ExitPlanMode boundaries across assistant events. */
  planTextParts: string[];
  /** Whether a proposed plan was already emitted for the current turn (from tool boundaries). */
  planProposedEmitted: boolean;
  /** Plan markdown extracted from a Write tool call to .claude/plans/. */
  planFileMarkdown: string | null;
  /** Path to the plan file detected from Write or Edit tool calls to .claude/plans/. */
  planFilePath: string | null;
}

interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  toolUseId: string;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

type ClaudeCodeSpawnProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

type ClaudeCodeSpawnSyncProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd: string;
    encoding: "utf8";
    stdio: ["ignore", "pipe", "pipe"];
    timeout: number;
    maxBuffer: number;
  },
) => SpawnSyncReturns<string>;

export interface ClaudeCodeManagerOptions {
  readonly spawnProcess?: ClaudeCodeSpawnProcess;
  readonly spawnSyncProcess?: ClaudeCodeSpawnSyncProcess;
}

export interface ClaudeCodeStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "claudeCode";
  readonly cwd?: string;
  readonly model?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly runtimeMode: RuntimeMode;
}

export interface ClaudeCodeImageAttachment {
  readonly mediaType: string;
  readonly base64Data: string;
}

export interface ClaudeCodeSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly model?: string;
  readonly images?: readonly ClaudeCodeImageAttachment[];
  readonly interactionMode?: ProviderInteractionMode;
}

export interface ClaudeCodeThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface ClaudeCodeThreadSnapshot {
  threadId: string;
  turns: ClaudeCodeThreadTurnSnapshot[];
}

export interface ClaudeCodeManagerEvents {
  event: [event: ProviderEvent];
}

const CLAUDE_DEFAULT_MODEL = "sonnet";

// ── Manager ──────────────────────────────────────────────────────────

export class ClaudeCodeManager extends EventEmitter<ClaudeCodeManagerEvents> {
  private readonly sessions = new Map<ThreadId, ClaudeCodeSessionContext>();
  private readonly spawnProcess: ClaudeCodeSpawnProcess;
  private readonly spawnSyncProcess: ClaudeCodeSpawnSyncProcess;

  constructor(options?: ClaudeCodeManagerOptions) {
    super();
    this.spawnProcess = options?.spawnProcess ?? spawn;
    this.spawnSyncProcess = options?.spawnSyncProcess ?? spawnSync;
  }

  async startSession(input: ClaudeCodeStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();

    try {
      const resolvedCwd = input.cwd ?? process.cwd();
      const model = normalizeModelSlug(input.model, "claudeCode") ?? CLAUDE_DEFAULT_MODEL;

      const claudeOptions = readClaudeProviderOptions(input);
      const binaryPath = claudeOptions.binaryPath ?? "claude";

      assertClaudeCliAvailable(binaryPath, resolvedCwd, this.spawnSyncProcess);

      const session: ProviderSession = {
        provider: "claudeCode",
        status: "ready",
        runtimeMode: input.runtimeMode,
        model,
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const ctx: ClaudeCodeSessionContext = {
        session,
        child: null,
        output: null,
        conversationId: readResumeCursorConversationId(input.resumeCursor) ?? null,
        pendingApprovals: new Map(),
        stopping: false,
        currentTurnId: null,
        currentInteractionMode: null,
        assistantTextBuffer: "",
        binaryPath,
        planModeActive: false,
        planTextParts: [],
        planProposedEmitted: false,
        planFileMarkdown: null,
        planFilePath: null,
      };

      this.sessions.set(threadId, ctx);

      this.emitLifecycleEvent(ctx, "session/ready", "Claude Code session ready");

      return { ...ctx.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Claude Code session.";
      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "error",
        provider: "claudeCode",
        threadId,
        createdAt: new Date().toISOString(),
        method: "session/startFailed",
        message,
      });
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: ClaudeCodeSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);

    if (!input.input?.trim()) {
      throw new Error("Turn input must include text.");
    }

    const turnId = TurnId.makeUnsafe(randomUUID());
    context.currentTurnId = turnId;
    context.currentInteractionMode = input.interactionMode ?? null;
    context.assistantTextBuffer = "";
    context.planModeActive = false;
    context.planTextParts = [];
    context.planProposedEmitted = false;
    context.planFileMarkdown = null;
    context.planFilePath = null;

    // Claude Code CLI runs one-shot per turn with --print.
    // For follow-up turns, we use --continue to resume the conversation.
    const model = normalizeModelSlug(
      input.model ?? context.session.model,
      "claudeCode",
    ) ?? CLAUDE_DEFAULT_MODEL;

    const hasImages = (input.images?.length ?? 0) > 0;

    const args = buildClaudeArgs({
      model,
      runtimeMode: context.session.runtimeMode,
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      resumeCursor: context.conversationId
        ? { conversationId: context.conversationId }
        : undefined,
      ...(hasImages ? {} : input.input !== undefined ? { prompt: input.input } : {}),
      ...(hasImages ? { hasImages: true } : {}),
    });

    // Kill any previous child that hasn't exited yet
    if (context.child && !context.child.killed && context.child.exitCode === null) {
      context.child.kill();
    }

    const childEnv = { ...process.env };
    // Remove CLAUDECODE to avoid "nested session" detection by the CLI
    delete childEnv.CLAUDECODE;

    const child = this.spawnProcess(context.binaryPath, args, {
      cwd: context.session.cwd ?? process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (hasImages) {
      // When images are present, send a structured user message via stdin
      // using the stream-json input format (Anthropic content block array).
      const contentBlocks: unknown[] = [];
      if (input.input) {
        contentBlocks.push({ type: "text", text: input.input });
      }
      for (const img of input.images!) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.base64Data,
          },
        });
      }
      const userMessage = JSON.stringify({
        type: "user",
        message: { role: "user", content: contentBlocks },
      });
      child.stdin.write(userMessage + "\n");
      child.stdin.end();
    } else {
      // In print mode Claude waits for stdin to close before flushing the
      // streamed result and exiting, even when the prompt is passed as an arg.
      child.stdin.end();
    }

    context.child = child;
    context.output = readline.createInterface({ input: child.stdout });
    this.attachProcessListeners(context);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "turn/started",
      turnId,
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.conversationId
        ? { resumeCursor: { conversationId: context.conversationId } }
        : {}),
    };
  }

  interruptTurn(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) return;

    if (context.child && !context.child.killed) {
      context.child.kill("SIGINT");
    }

    const turnId = context.currentTurnId;
    context.currentTurnId = null;

    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "turn/completed",
      turnId: turnId ?? undefined,
      payload: { turn: { status: "interrupted" } },
    });
  }

  respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): void {
    const context = this.requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);

    // Claude Code in stream-json mode doesn't support stdin-based approval.
    // Approvals are handled by starting Claude with appropriate permission flags.
    // This method exists for interface compliance but is effectively a no-op
    // since we configure permissions at session start via --allowedTools or
    // --dangerouslySkipPermissions based on runtimeMode.

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pending.turnId,
      itemId: pending.itemId,
      requestId: pending.requestId,
      payload: {
        requestId: pending.requestId,
        decision,
      },
    });
  }

  respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ): void {
    const context = this.requireSession(threadId);
    // Claude Code doesn't have a user input protocol equivalent.
    // This is a no-op for interface compliance.
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      payload: { requestId },
    });
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) return;

    context.stopping = true;
    context.pendingApprovals.clear();
    context.output?.close();

    if (context.child && !context.child.killed) {
      context.child.kill();
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({ ...session }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  readThread(threadId: ThreadId): ClaudeCodeThreadSnapshot {
    const context = this.requireSession(threadId);
    // Claude Code doesn't expose thread snapshots. Return minimal structure.
    return {
      threadId: context.conversationId ?? threadId,
      turns: [],
    };
  }

  rollbackThread(threadId: ThreadId, _numTurns: number): ClaudeCodeThreadSnapshot {
    // Claude Code doesn't support rollback. Return current state.
    return this.readThread(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  private requireSession(threadId: ThreadId): ClaudeCodeSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }
    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }
    return context;
  }

  private attachProcessListeners(context: ClaudeCodeSessionContext): void {
    const output = context.output!;
    const child = context.child!;

    output.on("line", (line) => {
      this.handleStdoutLine(context, line);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        this.emitErrorEvent(context, "process/stderr", trimmed);
      }
    });

    child.on("error", (error) => {
      const message = error.message || "Claude Code process errored.";
      this.updateSession(context, { status: "error", lastError: message });
      this.emitErrorEvent(context, "process/error", message);
    });

    child.on("exit", (code, signal) => {
      context.output?.close();
      context.output = null;
      context.child = null;

      if (context.stopping) return;

      const turnId = context.currentTurnId;
      context.currentTurnId = null;

      // Emit turn completed if a turn was active
      if (turnId) {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "claudeCode",
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "turn/completed",
          turnId,
          payload: {
            turn: {
              id: turnId,
              status: code === 0 ? "completed" : "failed",
              ...(code !== 0
                ? { error: { message: `Process exited with code ${code}, signal ${signal}` } }
                : {}),
            },
          },
        });
      }

      const message = `Claude Code exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;

      if (turnId) {
        this.updateSession(context, {
          status: code === 0 ? "ready" : "error",
          activeTurnId: undefined,
          lastError: code === 0 ? undefined : message,
        });
        return;
      }

      // Successful print-mode turns emit "result" before the child exits.
      // Keep the logical session alive so future turns can reuse the
      // persisted conversation state instead of collapsing to "stopped".
      if (code === 0 || signal === "SIGINT") {
        return;
      }

      this.updateSession(context, {
        status: "error",
        activeTurnId: undefined,
        lastError: message,
      });
      this.emitErrorEvent(context, "process/exit", message);
    });
  }

  private handleStdoutLine(context: ClaudeCodeSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const event = parsed as Record<string, unknown>;
    const eventType = typeof event.type === "string" ? event.type : undefined;

    if (!eventType) return;

    this.handleClaudeEvent(context, event, eventType);
  }

  private handleClaudeEvent(
    context: ClaudeCodeSessionContext,
    event: Record<string, unknown>,
    eventType: string,
  ): void {
    const threadId = context.session.threadId;
    const turnId = context.currentTurnId ?? undefined;
    const now = new Date().toISOString();

    // Extract session/conversation ID from system events
    if (eventType === "system" && typeof event.session_id === "string") {
      context.conversationId = event.session_id;
      this.updateSession(context, {
        resumeCursor: { conversationId: event.session_id },
      });
    }

    // Map Claude Code stream-json events to ProviderEvents
    switch (eventType) {
      case "system": {
        const conversationId = asString(event.session_id);
        if (conversationId) {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "session",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "session/started",
            payload: { conversationId },
          });
        }
        break;
      }

      case "assistant": {
        // In --print mode, the full assistant message arrives as a single event.
        // Extract text from message.content blocks and emit created + delta + completed.
        const message = asObject(event.message);
        const messageId = asString(message?.id);
        const itemId = messageId ? ProviderItemId.makeUnsafe(messageId) : undefined;
        const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];

        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "claudeCode",
          threadId,
          createdAt: now,
          method: "item/agentMessage/created",
          turnId,
          ...(itemId ? { itemId } : {}),
          payload: event,
        });

        // Emit content blocks as deltas
        for (const block of content) {
          const b = asObject(block);
          if (!b) continue;
          const blockType = asString(b.type);

          if (blockType === "tool_use") {
            const toolName = asString(b.name);
            const toolNameLower = toolName?.toLowerCase();

            // Track plan mode boundaries (persisted on context across assistant events)
            if (toolNameLower === "enterplanmode") {
              context.planModeActive = true;
            } else if (toolNameLower === "exitplanmode") {
              context.planModeActive = false;
            }

            // Detect plan file writes/edits (e.g. Write/Edit to .claude/plans/*.md)
            if (toolNameLower === "write" || toolNameLower === "edit") {
              const toolInput = asObject(b.input);
              const filePath = asString(toolInput?.file_path);
              if (filePath && /[/\\]\.claude[/\\]plans[/\\]/.test(filePath)) {
                context.planFilePath = filePath;
                // For Write we can capture full content directly; Edit only has old/new strings
                if (toolNameLower === "write") {
                  const fileContent = asString(toolInput?.content);
                  if (fileContent) {
                    context.planFileMarkdown = fileContent;
                  }
                }
              }
            }

            const toolId = asString(b.id);
            this.emitEvent({
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: "claudeCode",
              threadId,
              createdAt: now,
              method: "item/tool/created",
              turnId,
              ...(toolId ? { itemId: ProviderItemId.makeUnsafe(toolId) } : {}),
              payload: { ...event, toolName, command: toolName },
            });
            this.emitEvent({
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: "claudeCode",
              threadId,
              createdAt: now,
              method: "item/tool/completed",
              turnId,
              ...(toolId ? { itemId: ProviderItemId.makeUnsafe(toolId) } : {}),
              payload: {
                ...event,
                item: { type: mapToolType(toolName), ...b },
              },
            });
          }

          if (blockType === "text") {
            const text = asString(b.text) ?? "";
            context.assistantTextBuffer += text;

            // Collect text produced while in plan mode
            if (context.planModeActive) {
              context.planTextParts.push(text);
            }

            this.emitEvent({
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: "claudeCode",
              threadId,
              createdAt: now,
              method: "item/agentMessage/delta",
              turnId,
              ...(itemId ? { itemId } : {}),
              textDelta: text,
              payload: event,
            });
          } else if (blockType === "thinking") {
            const thinking = asString(b.thinking) ?? "";
            this.emitEvent({
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: "claudeCode",
              threadId,
              createdAt: now,
              method: "item/reasoning/textDelta",
              turnId,
              textDelta: thinking,
              payload: event,
            });
          } else if (blockType === "tool_result") {
            // Tool results from multi-turn agentic flows
            const toolId = asString(b.tool_use_id);
            this.emitEvent({
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: "claudeCode",
              threadId,
              createdAt: now,
              method: "item/tool/completed",
              turnId,
              ...(toolId ? { itemId: ProviderItemId.makeUnsafe(toolId) } : {}),
              payload: { ...event, item: { type: "toolResult", ...b } },
            });
          }
        }

        // Emit proposed plan if plan text was captured via tool boundaries
        // (EnterPlanMode/ExitPlanMode). The fallback for plan mode without
        // boundaries is deferred to turn completion (result event).
        const planMarkdown = context.planTextParts.join("").trim();
        if (planMarkdown.length > 0 && !context.planProposedEmitted) {
          context.planProposedEmitted = true;
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "item/plan/proposed",
            turnId,
            payload: { planMarkdown },
          });
        }

        // Mark message complete
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "claudeCode",
          threadId,
          createdAt: now,
          method: "item/agentMessage/completed",
          turnId,
          ...(itemId ? { itemId } : {}),
          payload: event,
        });

        // Capture session ID if present
        const sessionId = asString(event.session_id);
        if (sessionId) {
          context.conversationId = sessionId;
          this.updateSession(context, {
            resumeCursor: { conversationId: sessionId },
          });
        }
        break;
      }

      case "content_block_start": {
        // Streaming mode events (if Claude Code ever switches to streaming output)
        const contentBlock = asObject(event.content_block);
        const blockType = asString(contentBlock?.type);
        if (blockType === "thinking") {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "item/reasoning/created",
            turnId,
            payload: event,
          });
        } else if (blockType === "tool_use") {
          const toolName = asString(contentBlock?.name);
          const toolId = asString(contentBlock?.id);
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "item/tool/created",
            turnId,
            ...(toolId ? { itemId: ProviderItemId.makeUnsafe(toolId) } : {}),
            payload: { ...event, toolName, command: toolName },
          });
        }
        break;
      }

      case "content_block_delta": {
        const delta = asObject(event.delta);
        const deltaType = asString(delta?.type);

        if (deltaType === "text_delta") {
          const text = asString(delta?.text) ?? "";
          context.assistantTextBuffer += text;
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "item/agentMessage/delta",
            turnId,
            textDelta: text,
            payload: event,
          });
        } else if (deltaType === "thinking_delta") {
          const thinking = asString(delta?.thinking) ?? "";
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "item/reasoning/textDelta",
            turnId,
            textDelta: thinking,
            payload: event,
          });
        }
        break;
      }

      case "content_block_stop": {
        const contentBlock = asObject(event.content_block);
        const blockType = asString(contentBlock?.type);
        if (blockType === "tool_use") {
          const toolId = asString(contentBlock?.id);
          const toolName = asString(contentBlock?.name);
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "item/tool/completed",
            turnId,
            ...(toolId ? { itemId: ProviderItemId.makeUnsafe(toolId) } : {}),
            payload: {
              ...event,
              item: { type: mapToolType(toolName), ...contentBlock },
            },
          });
        }
        break;
      }

      case "message_start": {
        const message = asObject(event.message);
        const role = asString(message?.role);
        if (role === "assistant") {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "item/agentMessage/created",
            turnId,
            payload: event,
          });
        }
        break;
      }

      case "message_delta": {
        const delta = asObject(event.delta);
        const stopReason = asString(delta?.stop_reason);
        if (stopReason) {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: "claudeCode",
            threadId,
            createdAt: now,
            method: "item/agentMessage/completed",
            turnId,
            payload: event,
          });
        }
        break;
      }

      case "message_stop": {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "claudeCode",
          threadId,
          createdAt: now,
          method: "item/agentMessage/completed",
          turnId,
          payload: event,
        });
        break;
      }

      case "result": {
        // Turn completed with final result
        context.currentTurnId = null;
        const conversationId = asString(event.session_id);
        if (conversationId) {
          context.conversationId = conversationId;
          this.updateSession(context, {
            resumeCursor: { conversationId },
          });
        }

        // Fallback: when interactionMode is "plan" but no plan was emitted
        // via tool boundaries, emit the plan. Prefer content written to
        // .claude/plans/*.md (the canonical plan file), falling back to
        // the full assistant text buffer as a last resort.
        // When the plan file was edited (not written from scratch), read
        // the updated content from disk.
        if (context.currentInteractionMode === "plan" && !context.planProposedEmitted) {
          let planFromFile = context.planFileMarkdown?.trim();
          if (!planFromFile && context.planFilePath) {
            try {
              const absPath = resolve(context.session.cwd ?? process.cwd(), context.planFilePath);
              planFromFile = readFileSync(absPath, "utf-8").trim();
            } catch {
              // File may have been removed or unreadable – fall through
            }
          }
          const fallbackMarkdown = planFromFile || context.assistantTextBuffer.trim();
          if (fallbackMarkdown.length > 0) {
            context.planProposedEmitted = true;
            this.emitEvent({
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: "claudeCode",
              threadId,
              createdAt: now,
              method: "item/plan/proposed",
              turnId,
              payload: { planMarkdown: fallbackMarkdown },
            });
          }
        }

        this.updateSession(context, {
          status: "ready",
          activeTurnId: undefined,
        });

        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "claudeCode",
          threadId,
          createdAt: now,
          method: "turn/completed",
          turnId,
          payload: {
            turn: {
              id: turnId,
              status: "completed",
            },
            result: event,
          },
        });
        break;
      }

      case "error": {
        const errorObj = asObject(event.error);
        const message = asString(errorObj?.message) ?? asString(event.message) ?? "Unknown error";
        this.emitErrorEvent(context, "provider/error", message);
        break;
      }

      default: {
        // Pass through unknown events as generic notifications
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "claudeCode",
          threadId,
          createdAt: now,
          method: `claude/${eventType}`,
          turnId,
          payload: event,
        });
        break;
      }
    }
  }

  private emitLifecycleEvent(context: ClaudeCodeSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: ClaudeCodeSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "claudeCode",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private updateSession(context: ClaudeCodeSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapToolType(toolName: string | undefined): string {
  if (!toolName) return "unknown";
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("command") || lower.includes("execute")) {
    return "commandExecution";
  }
  if (lower.includes("edit") || lower.includes("write") || lower.includes("file")) {
    return "fileChange";
  }
  if (lower.includes("read")) {
    return "fileRead";
  }
  if (lower.includes("mcp")) {
    return "mcpToolCall";
  }
  return "toolCall";
}

export function buildClaudeArgs(input: {
  model: string;
  runtimeMode: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  resumeCursor?: unknown;
  prompt?: string;
  hasImages?: boolean;
}): string[] {
  const args: string[] = [
    "--output-format", "stream-json",
    "--verbose",
    "--model", input.model,
  ];

  // Handle permissions based on runtime mode and interaction mode.
  // Plan mode uses --permission-mode plan which takes precedence.
  if (input.interactionMode === "plan") {
    args.push("--permission-mode", "plan");
  } else if (input.runtimeMode === "full-access") {
    args.push("--dangerously-skip-permissions");
  }

  // Handle session resumption
  const conversationId = readResumeCursorConversationId(input.resumeCursor);
  if (conversationId) {
    args.push("--resume", conversationId);
  }

  // When images are present, use stream-json input so we can send
  // structured content blocks (text + images) via stdin.
  if (input.hasImages) {
    args.push("--print", "--input-format", "stream-json");
  } else if (input.prompt) {
    // Add prompt as the last argument (for non-interactive mode)
    args.push("--print", input.prompt);
  }

  return args;
}

function readClaudeProviderOptions(input: ClaudeCodeStartSessionInput): {
  readonly binaryPath?: string;
} {
  const options = input.providerOptions?.claudeCode;
  if (!options) return {};
  return options.binaryPath ? { binaryPath: options.binaryPath } : {};
}

function readResumeCursorConversationId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawId = (resumeCursor as Record<string, unknown>).conversationId;
  return typeof rawId === "string" ? rawId.trim() || undefined : undefined;
}

function assertClaudeCliAvailable(
  binaryPath: string,
  cwd: string,
  spawnSyncProcess: ClaudeCodeSpawnSyncProcess = spawnSync,
): void {
  const result = spawnSyncProcess(binaryPath, ["--version"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 4_000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Claude Code CLI (${binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Claude Code CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Claude Code CLI version check failed. ${detail}`);
  }
}
