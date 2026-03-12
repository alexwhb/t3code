import { Effect, Layer, Schema, ServiceMap } from "effect";
import type { SttTranscribeInput, SttTranscribeResult } from "@t3tools/contracts";
import { spawn } from "node:child_process";

export class SttTranscribeError extends Schema.TaggedErrorClass<SttTranscribeError>()(
  "SttTranscribeError",
  { message: Schema.String },
) {}

interface SttServiceShape {
  readonly transcribe: (
    input: SttTranscribeInput,
  ) => Effect.Effect<SttTranscribeResult, SttTranscribeError>;
}

export class SttService extends ServiceMap.Service<SttService, SttServiceShape>()(
  "t3/stt/Services/SttService",
) {}

const DEFAULT_WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_WHISPER_MODEL = "whisper-1";

/** Convert audio buffer to 16kHz mono WAV via ffmpeg stdin/stdout pipes (no temp files). */
const convertToWav = (audioBuffer: Buffer): Effect.Effect<Buffer, SttTranscribeError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
        const proc = spawn(
          "ffmpeg",
          ["-i", "pipe:0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"],
          { stdio: ["pipe", "pipe", "pipe"] },
        );

        const chunks: Buffer[] = [];
        proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        proc.on("close", (code) => {
          if (code === 0) resolve(Buffer.concat(chunks));
          else reject(new Error(`ffmpeg exited with code ${code}`));
        });
        proc.on("error", reject);
        proc.stdin.write(audioBuffer);
        proc.stdin.end();
      }),
    catch: (cause) =>
      new SttTranscribeError({
        message: `Failed to convert audio to WAV: ${String(cause)}`,
      }),
  });

const makeSttService = Effect.succeed(
  SttService.of({
    transcribe: (input) =>
      Effect.gen(function* () {
        const endpoint = input.endpoint?.trim() || DEFAULT_WHISPER_ENDPOINT;
        const model = input.model?.trim() || DEFAULT_WHISPER_MODEL;

        // Resolve API key: prefer client-provided, fall back to OPENAI_API_KEY env var
        const apiKey = input.apiKey?.trim() || process.env.OPENAI_API_KEY || "";

        // Build the audio buffer from base64
        const audioBuffer = Buffer.from(input.audioBase64, "base64");

        // Determine file extension from mimeType
        const ext = input.mimeType.includes("mp4")
          ? "mp4"
          : input.mimeType.includes("ogg")
            ? "ogg"
            : "webm";

        const isOpenAi = endpoint.includes("api.openai.com");

        // whisper.cpp only accepts WAV — convert if needed
        const needsConversion = !isOpenAi && !input.mimeType.includes("wav");
        const finalBuffer = needsConversion ? yield* convertToWav(audioBuffer) : audioBuffer;
        const finalMime = needsConversion ? "audio/wav" : input.mimeType;
        const finalExt = needsConversion ? "wav" : ext;

        // Build multipart form data
        const formData = new FormData();
        formData.append("file", new Blob([finalBuffer], { type: finalMime }), `audio.${finalExt}`);
        // OpenAI requires the model field; whisper.cpp ignores it
        if (isOpenAi || model !== DEFAULT_WHISPER_MODEL) {
          formData.append("model", model);
        }
        // whisper.cpp needs explicit response_format=json
        formData.append("response_format", "json");
        if (input.language) {
          formData.append("language", input.language);
        }

        const headers: Record<string, string> = {};
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(endpoint, {
              method: "POST",
              headers,
              body: formData,
            }),
          catch: (cause) =>
            new SttTranscribeError({
              message: `Failed to reach Whisper endpoint: ${String(cause)}`,
            }),
        });

        if (!response.ok) {
          const body = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () =>
              new SttTranscribeError({
                message: `Whisper API returned ${response.status}`,
              }),
          });
          return yield* new SttTranscribeError({
            message: `Whisper API error (${response.status}): ${body.slice(0, 500)}`,
          });
        }

        const json = yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ text?: string }>,
          catch: (cause) =>
            new SttTranscribeError({
              message: `Failed to parse Whisper response: ${String(cause)}`,
            }),
        });

        return { text: json.text ?? "" };
      }),
  }),
);

export const SttServiceLive = Layer.effect(SttService, makeSttService);
