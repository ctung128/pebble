/** Mirrors the worker's accepted uploads (services/worker api.py) for early feedback. */
export const SUPPORTED_EXTENSIONS = [
  ".m4a",
  ".mp4",
  ".aac",
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".webm",
] as const;
export const MAX_UPLOAD_BYTES = 2048 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 200;

export function titleFromFilename(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  return stem.replace(/[_]+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

export function fileProblem(file: File): string | null {
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (
    !file.name.includes(".") ||
    !(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)
  ) {
    return "This file type isn't supported. Choose an M4A, MP3, WAV, FLAC, OGG/Opus, WebM or AAC file.";
  }
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "This file is larger than the 2 GB limit.";
  return null;
}

export function titleProblem(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return "Give the episode a title.";
  if (trimmed.length > MAX_TITLE_LENGTH)
    return `Keep the title under ${MAX_TITLE_LENGTH} characters.`;
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
