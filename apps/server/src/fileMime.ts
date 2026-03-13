import Mime from "@effect/platform-node/Mime";

export const TEXT_FILE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/tab-separated-values": ".tsv",
  "text/xml": ".xml",
  "text/html": ".html",
  "text/css": ".css",
  "text/markdown": ".md",
  "text/yaml": ".yaml",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/yaml": ".yaml",
  "application/x-yaml": ".yaml",
  "application/javascript": ".js",
  "application/typescript": ".ts",
  "application/toml": ".toml",
};

export const SAFE_TEXT_FILE_EXTENSIONS = new Set(Object.values(TEXT_FILE_EXTENSION_BY_MIME_TYPE));

export function inferFileExtension(input: { mimeType: string; fileName?: string }): string {
  const key = input.mimeType.toLowerCase();
  const fromMime = Object.hasOwn(TEXT_FILE_EXTENSION_BY_MIME_TYPE, key)
    ? TEXT_FILE_EXTENSION_BY_MIME_TYPE[key]
    : undefined;
  if (fromMime) {
    return fromMime;
  }

  const rawExtension = Mime.getExtension(input.mimeType);
  const fromMimeExtension = rawExtension ? `.${rawExtension}` : undefined;
  if (fromMimeExtension && SAFE_TEXT_FILE_EXTENSIONS.has(fromMimeExtension)) {
    return fromMimeExtension;
  }

  const fileName = input.fileName?.trim() ?? "";
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  if (SAFE_TEXT_FILE_EXTENSIONS.has(fileNameExtension)) {
    return fileNameExtension;
  }

  return ".txt";
}
