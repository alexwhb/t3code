import sharp from "sharp";

/**
 * Claude API limit for base64-encoded image data (5 MB).
 * We target slightly below to leave headroom.
 */
const MAX_BASE64_BYTES = 5 * 1024 * 1024;
const TARGET_BASE64_BYTES = 4.8 * 1024 * 1024;

/** MIME types that sharp can process for re-encoding. */
const COMPRESSIBLE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/tiff",
  "image/avif",
  "image/heif",
  "image/heic",
  "image/bmp",
]);

/**
 * If the raw image bytes would produce a base64 string exceeding the Claude API
 * limit (5 MB), compresses the image using sharp. Returns the (possibly
 * compressed) bytes and updated media type.
 */
export async function compressImageIfNeeded(
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const base64Size = Math.ceil(bytes.byteLength * (4 / 3));
  if (base64Size <= MAX_BASE64_BYTES) {
    return { bytes, mediaType };
  }

  console.log(
    `[imageCompression] Image base64 would be ${(base64Size / 1024 / 1024).toFixed(1)}MB (limit ${(MAX_BASE64_BYTES / 1024 / 1024).toFixed(0)}MB), compressing...`,
  );

  if (!COMPRESSIBLE_MIME_TYPES.has(mediaType.toLowerCase())) {
    console.warn(`[imageCompression] Cannot compress unsupported mime type: ${mediaType}`);
    return { bytes, mediaType };
  }

  // Calculate target file size from target base64 size
  const targetBytes = Math.floor(TARGET_BASE64_BYTES * (3 / 4));

  // Try progressively lower JPEG quality until we fit
  const qualities = [90, 80, 70, 55, 40];
  for (const quality of qualities) {
    const compressed = await sharp(bytes).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (compressed.byteLength <= targetBytes) {
      console.log(
        `[imageCompression] Compressed to ${(compressed.byteLength / 1024).toFixed(0)}KB at quality ${quality}`,
      );
      return { bytes: new Uint8Array(compressed), mediaType: "image/jpeg" };
    }
  }

  // If quality alone isn't enough, resize down and use low quality
  const metadata = await sharp(bytes).metadata();
  const width = metadata.width ?? 1920;
  const height = metadata.height ?? 1080;

  // Scale down to fit within target size — halve dimensions as a simple approach
  const scale = Math.sqrt(targetBytes / bytes.byteLength) * 0.9;
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);

  const resized = await sharp(bytes)
    .resize(newWidth, newHeight, { fit: "inside" })
    .jpeg({ quality: 60, mozjpeg: true })
    .toBuffer();

  return { bytes: new Uint8Array(resized), mediaType: "image/jpeg" };
}
