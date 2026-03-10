export type SttProviderKind = "browser" | "whisper";

export const STT_PROVIDER_OPTIONS: readonly {
  readonly value: SttProviderKind;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: "browser",
    label: "Browser (built-in)",
    description: "Uses Web Speech API. Chrome recommended. Not available in the desktop app.",
  },
  {
    value: "whisper",
    label: "OpenAI Whisper",
    description: "Works in all browsers. Supports local or cloud Whisper servers.",
  },
] as const;
