import { Effect, Layer, Schema, ServiceMap } from "effect";
import type { SttTranscribeInput, SttTranscribeResult } from "@t3tools/contracts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

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

/** Convert audio buffer to 16kHz mono WAV using ffmpeg (required by whisper.cpp). */
const convertToWav = (audioBuffer: Buffer, mimeType: string): Effect.Effect<Buffer, SttTranscribeError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = await mkdtemp(join(tmpdir(), "stt-"));
      const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
      const inputPath = join(dir, `input.${ext}`);
      const outputPath = join(dir, "output.wav");
      await writeFile(inputPath, audioBuffer);
      await execFileAsync("ffmpeg", [
        "-y", "-i", inputPath,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        outputPath,
      ]);
      const wav = await readFile(outputPath);
      // Clean up temp files
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
      return wav;
    },
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
        const finalBuffer = needsConversion
          ? yield* convertToWav(audioBuffer, input.mimeType)
          : audioBuffer;
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
