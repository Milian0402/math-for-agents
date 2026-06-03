import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function hasArtifactContent(input) {
  return typeof input.content_text === "string" || typeof input.content_base64 === "string";
}

export async function materializeArtifactContent(workspaceId, artifact, input, options = {}) {
  if (!hasArtifactContent(input)) return artifact;

  const content = decodeArtifactContent(input);
  const maxBytes = Number(process.env.ARTIFACT_MAX_BYTES || 10_000_000);
  if (content.bytes.length > maxBytes) {
    const error = new Error(`artifact content exceeds ${maxBytes} bytes`);
    error.statusCode = 413;
    throw error;
  }

  const fileName = safeFileName(input.file_name || `${artifact.id}.txt`);
  const storageKey = `${safeFileName(workspaceId)}/${artifact.id}-${fileName}`;
  const contentHash = `sha256:${createHash("sha256").update(content.bytes).digest("hex")}`;
  if (artifact.content_hash && artifact.content_hash !== contentHash) {
    const error = new Error("content_hash does not match uploaded artifact bytes");
    error.statusCode = 422;
    throw error;
  }

  if (artifactStorageDriver() === "vercel-blob") {
    return materializeVercelBlobArtifact(artifact, input, {
      bytes: content.bytes,
      contentHash,
      contentType: input.content_type || content.contentType,
      fileName,
      storageKey,
      overwrite: options.overwrite,
      blobClient: options.blobClient
    });
  }

  const absolutePath = path.join(storageRoot(), storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content.bytes, { flag: options.overwrite ? "w" : "wx" });

  return {
    ...artifact,
    path: `/api/artifacts/${encodeURIComponent(artifact.id)}/file`,
    content_hash: contentHash,
    metadata: {
      ...artifact.metadata,
      storage: {
        driver: "local-file",
        key: storageKey,
        file_name: fileName,
        content_type: input.content_type || content.contentType,
        bytes: content.bytes.length
      }
    }
  };
}

export async function openArtifactFile(artifact, options = {}) {
  const storageKey = artifact?.metadata?.storage?.key;
  if (!storageKey) return null;
  if (artifact.metadata.storage.driver === "vercel-blob") {
    return openVercelBlobArtifact(artifact, options);
  }

  const rootPath = storageRoot();
  const filePath = path.join(rootPath, storageKey);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) return null;
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) return null;
  return {
    stream: createReadStream(filePath),
    size: fileStat.size,
    contentType: artifact.metadata.storage.content_type || "application/octet-stream",
    fileName: artifact.metadata.storage.file_name || `${artifact.id}.bin`
  };
}

export function artifactStorageDriver(env = process.env) {
  return env.ARTIFACT_STORAGE_DRIVER || "local-file";
}

async function materializeVercelBlobArtifact(artifact, input, options) {
  const blob = options.blobClient || await vercelBlobClient();
  const uploaded = await blob.put(options.storageKey, options.bytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: Boolean(options.overwrite),
    contentType: options.contentType
  });

  return {
    ...artifact,
    path: `/api/artifacts/${encodeURIComponent(artifact.id)}/file`,
    content_hash: options.contentHash,
    metadata: {
      ...artifact.metadata,
      storage: {
        driver: "vercel-blob",
        key: uploaded.pathname || options.storageKey,
        file_name: options.fileName,
        content_type: uploaded.contentType || options.contentType,
        bytes: options.bytes.length,
        etag: uploaded.etag || null,
        access: "private"
      }
    }
  };
}

async function openVercelBlobArtifact(artifact, options = {}) {
  const storage = artifact.metadata.storage;
  const blob = options.blobClient || await vercelBlobClient();
  const result = await blob.get(storage.key, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) return null;

  return {
    stream: Readable.fromWeb(result.stream),
    size: result.blob?.size || storage.bytes || 0,
    contentType: result.blob?.contentType || storage.content_type || "application/octet-stream",
    fileName: storage.file_name || `${artifact.id}.bin`
  };
}

async function vercelBlobClient() {
  return import("@vercel/blob");
}

function decodeArtifactContent(input) {
  if (typeof input.content_text === "string") {
    return {
      bytes: Buffer.from(input.content_text, "utf8"),
      contentType: input.content_type || "text/plain; charset=utf-8"
    };
  }

  if (typeof input.content_base64 === "string") {
    return {
      bytes: Buffer.from(input.content_base64, "base64"),
      contentType: input.content_type || "application/octet-stream"
    };
  }

  return {
    bytes: Buffer.alloc(0),
    contentType: "application/octet-stream"
  };
}

function storageRoot() {
  return path.resolve(process.env.ARTIFACT_STORAGE_DIR || path.join(root, "artifacts"));
}

function safeFileName(value) {
  const cleaned = String(value || "artifact")
    .replace(/^agent:/, "agent-")
    .replace(/^workspace:/, "workspace-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || "artifact";
}
