import { Schema } from "effect";

export const SttTranscribeInput = Schema.Struct({
  audioBase64: Schema.String,
  mimeType: Schema.String,
  language: Schema.optional(Schema.String),
  endpoint: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});
export type SttTranscribeInput = typeof SttTranscribeInput.Type;

export const SttTranscribeResult = Schema.Struct({
  text: Schema.String,
});
export type SttTranscribeResult = typeof SttTranscribeResult.Type;
