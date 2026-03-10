import { useCallback, useEffect, useRef, useState } from "react";
import { isElectron } from "../env";
import type { SttProviderKind } from "../sttProviders";

interface SpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, SpeechRecognitionConstructor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const SUPPORTED_MEDIA_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"] as const;

function getSupportedMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of SUPPORTED_MEDIA_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone access denied. Check browser permissions.",
  "no-speech": "No speech detected. Try again.",
  "audio-capture": "No microphone found.",
  network: "Network error during speech recognition.",
  aborted: "Speech recognition was aborted.",
};

export interface UseSpeechToTextOptions {
  provider: SttProviderKind;
  onTranscript: (text: string) => void;
  onInterim?: (text: string) => void;
  transcribeAudio?: (audioBase64: string, mimeType: string) => Promise<string>;
}

export interface UseSpeechToTextResult {
  isListening: boolean;
  isTranscribing: boolean;
  isSupported: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useSpeechToText({
  provider,
  onTranscript,
  onInterim,
  transcribeAudio,
}: UseSpeechToTextOptions): UseSpeechToTextResult {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const whisperActiveRef = useRef(false);
  const whisperIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentRecorderRef = useRef<MediaRecorder | null>(null);
  const intentionalStopRef = useRef(false);
  const hasReceivedResultRef = useRef(false);

  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onInterimRef = useRef(onInterim);
  onInterimRef.current = onInterim;
  const transcribeAudioRef = useRef(transcribeAudio);
  transcribeAudioRef.current = transcribeAudio;

  // Web Speech API exists in Electron but fails silently — Google's speech
  // servers are unreachable from the Electron network stack.
  const isBrowserSupported =
    !isElectron && typeof window !== "undefined" && getSpeechRecognitionConstructor() !== null;
  const isWhisperSupported = typeof MediaRecorder !== "undefined" && getSupportedMimeType() !== null;
  const isSupported = provider === "browser" ? isBrowserSupported : isWhisperSupported;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      whisperActiveRef.current = false;
      if (whisperIntervalRef.current) clearInterval(whisperIntervalRef.current);
      currentRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const startBrowser = useCallback(() => {
    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) return;

    setError(null);
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognitionRef.current = recognition;
    intentionalStopRef.current = false;
    hasReceivedResultRef.current = false;

    recognition.addEventListener("result", ((event: SpeechRecognitionEvent) => {
      hasReceivedResultRef.current = true;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          onTranscriptRef.current(transcript);
        } else {
          interim += transcript;
        }
      }
      if (interim && onInterimRef.current) {
        onInterimRef.current(interim);
      }
    }) as unknown as EventListener);

    recognition.addEventListener("error", ((event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are not fatal
      if (event.error === "no-speech" || event.error === "aborted") return;
      setError(ERROR_MESSAGES[event.error] ?? `Speech recognition error: ${event.error}`);
      setIsListening(false);
    }) as unknown as EventListener);

    recognition.addEventListener("end", () => {
      if (!intentionalStopRef.current) {
        // If recognition ended without ever receiving a result, the backend
        // is likely unreachable (e.g. Electron). Stop to avoid a restart loop.
        if (!hasReceivedResultRef.current) {
          setError("Speech recognition is not available in this environment.");
          setIsListening(false);
          return;
        }
        // Browser auto-stopped after producing results, restart for continuous listening
        hasReceivedResultRef.current = false;
        try {
          recognition.start();
        } catch {
          setIsListening(false);
        }
        return;
      }
      setIsListening(false);
    });

    try {
      recognition.start();
      setIsListening(true);
    } catch {
      setError("Failed to start speech recognition.");
    }
  }, []);

  const stopBrowser = useCallback(() => {
    intentionalStopRef.current = true;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }, []);

  const transcribeChunk = useCallback(async (blob: Blob) => {
    if (blob.size === 0) return;
    const transcribeFn = transcribeAudioRef.current;
    if (!transcribeFn) return;

    try {
      const buffer = await blob.arrayBuffer();
      console.log("[STT] Sending chunk to Whisper, size:", buffer.byteLength, "bytes");
      const base64 = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
      );
      let text = await transcribeFn(base64, blob.type);
      // whisper.cpp emits "[BLANK_AUDIO]" for silent chunks
      text = text.replace(/\[BLANK_AUDIO\]/g, "").trim();
      console.log("[STT] Whisper transcript:", text);
      if (text) {
        onTranscriptRef.current(text);
      }
    } catch (err) {
      console.error("[STT] Whisper transcription error:", err);
      setError(err instanceof Error ? err.message : "Transcription failed.");
    }
  }, []);

  /** Start a fresh MediaRecorder on the given stream and return it. */
  const createChunkRecorder = useCallback(
    (stream: MediaStream, mimeType: string): MediaRecorder => {
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType });

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });

      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: mimeType });
        // Fire-and-forget transcription so it doesn't block the next chunk
        void transcribeChunk(blob);
      });

      recorder.start();
      return recorder;
    },
    [transcribeChunk],
  );

  const CHUNK_INTERVAL_MS = 3_000;

  const startWhisper = useCallback(async () => {
    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      console.warn("[STT] No supported audio MIME type found for MediaRecorder");
      return;
    }

    console.log("[STT] Starting continuous Whisper recording with mimeType:", mimeType);
    setError(null);
    whisperActiveRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Start the first chunk recorder
      currentRecorderRef.current = createChunkRecorder(stream, mimeType);

      // Every CHUNK_INTERVAL_MS, stop the current recorder (triggers transcription)
      // and immediately start a new one so there's no gap in audio capture.
      whisperIntervalRef.current = setInterval(() => {
        if (!whisperActiveRef.current || !mediaStreamRef.current) return;
        const prev = currentRecorderRef.current;
        // Start the new recorder *before* stopping the old one to minimize gap
        currentRecorderRef.current = createChunkRecorder(stream, mimeType);
        if (prev?.state === "recording") prev.stop();
      }, CHUNK_INTERVAL_MS);

      setIsListening(true);
    } catch (err) {
      console.error("[STT] Microphone access error:", err);
      whisperActiveRef.current = false;
      setError("Microphone access denied. Check browser permissions.");
    }
  }, [createChunkRecorder]);

  const stopWhisper = useCallback(() => {
    whisperActiveRef.current = false;
    if (whisperIntervalRef.current) {
      clearInterval(whisperIntervalRef.current);
      whisperIntervalRef.current = null;
    }
    // Stop the current recorder to flush the last chunk for transcription
    if (currentRecorderRef.current?.state === "recording") {
      currentRecorderRef.current.stop();
    }
    currentRecorderRef.current = null;
    // Release the microphone
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    setIsListening(false);
  }, []);

  const start = useCallback(() => {
    if (provider === "browser") {
      startBrowser();
    } else {
      void startWhisper();
    }
  }, [provider, startBrowser, startWhisper]);

  const stop = useCallback(() => {
    if (provider === "browser") {
      stopBrowser();
    } else {
      stopWhisper();
    }
  }, [provider, stopBrowser, stopWhisper]);

  return {
    isListening,
    isTranscribing,
    isSupported,
    error,
    start,
    stop,
  };
}
