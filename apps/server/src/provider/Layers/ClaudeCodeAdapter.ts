/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Wraps `ClaudeCodeManager` behind the `ClaudeCodeAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module ClaudeCodeAdapterLive
 */
import {
  type CanonicalItemType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ProviderItemId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import {
  ClaudeCodeManager,
  type ClaudeCodeFileAttachment,
  type ClaudeCodeImageAttachment,
  type ClaudeCodeStartSessionInput,
} from "../../claudeCodeManager.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;

export interface ClaudeCodeAdapterLiveOptions {
  readonly manager?: ClaudeCodeManager;
  readonly makeManager?: () => ClaudeCodeManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

// ── Event mapping helpers ────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;
  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: "claude.stream-json",
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = asString(raw)?.toLowerCase() ?? "";
  if (type.includes("commandexecution") || type.includes("bash") || type.includes("command"))
    return "command_execution";
  if (
    type.includes("filechange") ||
    type.includes("edit") ||
    type.includes("write") ||
    type.includes("patch")
  )
    return "file_change";
  if (type.includes("fileread") || type.includes("read")) return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("toolcall") || type.includes("tool")) return "dynamic_tool_call";
  if (type.includes("agent") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thinking")) return "reasoning";
  if (type.includes("web") || type.includes("search")) return "web_search";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "reasoning":
      return "Reasoning";
    case "web_search":
      return "Web search";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);

  if (event.kind === "error") {
    if (!event.message) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    console.log("[DEBUG:ClaudeCodeAdapter] turn/completed received", {
      threadId: canonicalThreadId,
      turnId: event.turnId,
      method: event.method,
    });
    const turn = asObject(payload?.turn);
    const status = asString(turn?.status);
    const errorMessage = asString(asObject(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state:
            status === "failed"
              ? "failed"
              : status === "interrupted"
                ? "interrupted"
                : status === "cancelled"
                  ? "cancelled"
                  : "completed",
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  // Assistant message created
  if (event.method === "item/agentMessage/created") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started",
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
          title: "Assistant message",
        },
      },
    ];
  }

  // Assistant message completed
  if (event.method === "item/agentMessage/completed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
        },
      },
    ];
  }

  // Text deltas
  if (event.method === "item/agentMessage/delta" || event.method === "item/reasoning/textDelta") {
    const delta = event.textDelta ?? asString(payload?.delta) ?? asString(payload?.text);
    if (!delta || delta.length === 0) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
        },
      },
    ];
  }

  // Reasoning created
  if (event.method === "item/reasoning/created") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started",
        payload: {
          itemType: "reasoning",
          status: "inProgress",
          title: "Reasoning",
        },
      },
    ];
  }

  // Tool created
  if (event.method === "item/tool/created") {
    const toolName = asString(payload?.toolName) ?? asString(payload?.command);
    const itemType = toCanonicalItemType(asString(payload?.type) ?? toolName ?? "tool");
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started",
        payload: {
          itemType,
          status: "inProgress",
          title: itemTitle(itemType),
          ...(toolName ? { detail: toolName } : {}),
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  // Tool completed
  if (event.method === "item/tool/completed") {
    const item = asObject(payload?.item) ?? payload;
    const itemType = item ? toCanonicalItemType(asString(item.type) ?? "tool") : "unknown";
    const toolName =
      asString(payload?.toolName) ?? asString(payload?.command) ?? asString(item?.name);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.completed",
        payload: {
          itemType,
          status: "completed",
          title: itemTitle(itemType),
          ...(toolName ? { detail: toolName } : {}),
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  // Approval decision
  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = asString(payload?.decision);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType: "unknown",
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  // User input answered
  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: {},
        },
      },
    ];
  }

  // Proposed plan from plan mode
  if (event.method === "item/plan/proposed") {
    const planMarkdown = asString(payload?.planMarkdown);
    if (!planMarkdown || planMarkdown.length === 0) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown,
        },
      },
    ];
  }

  // Follow-up suggested (Claude promised to check back in one-shot mode)
  if (event.method === "turn/followUpSuggested") {
    const suggestedPrompt = asString(payload?.suggestedPrompt);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.warning",
        payload: {
          message: "Claude indicated it would follow up, but cannot in one-shot mode.",
          detail: {
            kind: "follow-up-suggested",
            ...(suggestedPrompt ? { suggestedPrompt } : {}),
          },
        },
      },
    ];
  }

  // Error from the provider
  if (event.method === "provider/error" || event.method === "error") {
    const message = event.message ?? "Provider runtime error";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  return [];
}

// ── Adapter factory ──────────────────────────────────────────────────

const makeClaudeCodeAdapter = (options?: ClaudeCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);

    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const manager = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (options?.manager) {
          return options.manager;
        }
        return options?.makeManager?.() ?? new ClaudeCodeManager();
      }),
      (manager) =>
        Effect.sync(() => {
          try {
            manager.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const managerInput: ClaudeCodeStartSessionInput = {
        threadId: input.threadId,
        provider: "claudeCode",
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        runtimeMode: input.runtimeMode,
      };

      return Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Claude Code adapter session."),
            cause,
          }),
      });
    };

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const images: ClaudeCodeImageAttachment[] = [];
        const files: ClaudeCodeFileAttachment[] = [];

        yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                stateDir: serverConfig.stateDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* toRequestError(
                  input.threadId,
                  "turn/start",
                  new Error(`Invalid attachment id '${attachment.id}'.`),
                );
              }
              const bytes = yield* fileSystem
                .readFile(attachmentPath)
                .pipe(
                  Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)),
                );
              if (attachment.type === "image") {
                images.push({
                  mediaType: attachment.mimeType,
                  base64Data: Buffer.from(bytes).toString("base64"),
                });
              } else {
                files.push({
                  fileName: attachment.name,
                  textContent: Buffer.from(bytes).toString("utf-8"),
                });
              }
            }),
          { concurrency: 1 },
        );

        return yield* Effect.tryPromise({
          try: () =>
            manager.sendTurn({
              threadId: input.threadId,
              ...(input.input !== undefined ? { input: input.input } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(images.length > 0 ? { images } : {}),
              ...(files.length > 0 ? { files } : {}),
              ...(input.interactionMode !== undefined
                ? { interactionMode: input.interactionMode }
                : {}),
            }),
          catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
        });
      }).pipe(
        Effect.map((result) => ({
          ...result,
          threadId: input.threadId,
        })),
      );

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.sync(() => {
        manager.interruptTurn(threadId);
      });

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.sync(() => {
        const snapshot = manager.readThread(threadId);
        return {
          threadId,
          turns: snapshot.turns,
        };
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (threadId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.sync(() => {
        const snapshot = manager.rollbackThread(threadId, numTurns);
        return {
          threadId,
          turns: snapshot.turns,
        };
      });
    };

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.sync(() => {
        manager.respondToRequest(threadId, requestId, decision);
      });

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.sync(() => {
        manager.respondToUserInput(threadId, requestId, answers);
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        manager.stopSession(threadId);
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        manager.stopAll();
      });

    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const writeNativeEvent = (event: ProviderEvent) =>
          Effect.gen(function* () {
            if (!nativeEventLogger) return;
            yield* nativeEventLogger.write(event, event.threadId);
          });

        const services = yield* Effect.services<never>();
        const listener = (event: ProviderEvent) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
            if (runtimeEvents.length === 0) {
              yield* Effect.logDebug("ignoring unhandled Claude Code provider event", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
              });
              return;
            }
            if (runtimeEvents.some((e) => e.type === "turn.completed")) {
              console.log("[DEBUG:ClaudeCodeAdapter] queuing turn.completed runtime event", {
                threadId: event.threadId,
                turnId: event.turnId,
              });
            }
            yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
          })
            .pipe(Effect.runPromiseWith(services))
            .catch((err) => {
              console.error("[DEBUG:ClaudeCodeAdapter] listener Effect rejected", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                error: err,
              });
            });
        manager.on("event", listener);
        return listener;
      }),
      (listener) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            manager.off("event", listener);
          });
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
