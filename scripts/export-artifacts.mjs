#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { openArtifactFile } from "../server/artifact-storage.js";
import { closePool, query } from "../server/db.js";

export async function exportArtifacts(options = {}) {
  const workspaceId = options.workspaceId || process.env.MFA_WORKSPACE_ID || "workspace:default";
  const outputDir = path.resolve(options.outputDir || "");
  if (!options.outputDir) throw new Error("output directory is required");

  const artifacts = options.artifacts || await loadArtifacts(workspaceId);
  const openFile = options.openFile || openArtifactFile;
  const records = [];

  await mkdir(outputDir, { recursive: true });

  for (const artifact of artifacts) {
    const storage = artifact.metadata?.storage || null;
    const record = {
      id: artifact.id,
      problem_id: artifact.problem_id,
      title: artifact.title,
      content_hash: artifact.content_hash || null,
      storage_driver: storage?.driver || null,
      storage_key: storage?.key || null,
      exported: false
    };

    if (!storage?.key) {
      record.reason = "path-only artifact";
      records.push(record);
      continue;
    }

    const file = await openFile(artifact);
    if (!file) throw new Error(`stored artifact ${artifact.id} could not be opened`);

    const relativePath = artifactExportPath(artifact, file.fileName);
    const targetPath = path.join(outputDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    const written = await writeStreamWithHash(file.stream, targetPath);
    const expected = expectedSha256(artifact.content_hash);
    if (expected && expected !== written.sha256) {
      throw new Error(`stored artifact ${artifact.id} hash mismatch`);
    }

    records.push({
      ...record,
      exported: true,
      path: relativePath.split(path.sep).join("/"),
      bytes: written.bytes,
      sha256: written.sha256,
      content_type: file.contentType,
      file_name: file.fileName
    });
  }

  const manifest = {
    created_at: new Date().toISOString(),
    workspace_id: workspaceId,
    artifact_count: records.length,
    exported_count: records.filter((record) => record.exported).length,
    artifacts: records
  };
  await writeFile(path.join(outputDir, "artifact-export-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function artifactExportPath(artifact, fileName) {
  return path.join(safePathPart(artifact.problem_id || "problem"), `${safePathPart(artifact.id)}-${safePathPart(fileName)}`);
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const key = arg.startsWith("--") ? arg.slice(2) : "";
    if (!key && !options.outputDir) {
      options.outputDir = path.resolve(process.cwd(), arg);
      continue;
    }
    if (!key) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    index += 1;
    if (key === "output-dir") options.outputDir = path.resolve(process.cwd(), value);
    else if (key === "workspace-id") options.workspaceId = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function loadArtifacts(workspaceId) {
  const result = await query(
    `select *
       from artifacts
      where workspace_id = $1
      order by problem_id asc, created_at asc, id asc`,
    [workspaceId]
  );
  return result.rows;
}

async function writeStreamWithHash(stream, targetPath) {
  const hash = createHash("sha256");
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      hash.update(buffer);
      callback(null, buffer);
    }
  });
  await pipeline(stream, hasher, createWriteStream(targetPath, { flags: "wx" }));
  return { bytes, sha256: hash.digest("hex") };
}

function expectedSha256(contentHash) {
  const match = String(contentHash || "").match(/^sha256:([a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : "";
}

function safePathPart(value) {
  const cleaned = String(value || "artifact")
    .replace(/^agent:/, "agent-")
    .replace(/^workspace:/, "workspace-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || "artifact";
}

function usage() {
  return `Usage:
  node scripts/export-artifacts.mjs <output-dir>
  node scripts/export-artifacts.mjs --output-dir <output-dir> --workspace-id workspace:default
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      exportArtifacts(options)
        .then((manifest) => {
          console.log(JSON.stringify(manifest, null, 2));
        })
        .catch((error) => {
          console.error(error.message);
          process.exitCode = 1;
        })
        .finally(async () => {
          await closePool();
        });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
