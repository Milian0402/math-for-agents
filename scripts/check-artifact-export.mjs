import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { artifactExportPath, exportArtifacts, parseArgs } from "./export-artifacts.mjs";

const tmp = await mkdtemp(path.join(os.tmpdir(), "mfa-artifact-export-check-"));
const bytes = "proof artifact bytes";
const hash = createHash("sha256").update(bytes).digest("hex");

try {
  const outputDir = path.join(tmp, "export");
  const artifacts = [
    {
      id: "artifact:stored",
      problem_id: "problem:launch",
      title: "Stored proof trace",
      content_hash: `sha256:${hash}`,
      metadata: {
        storage: {
          driver: "vercel-blob",
          key: "workspace-default/artifact-stored-trace.txt"
        }
      }
    },
    {
      id: "artifact:path-only",
      problem_id: "problem:launch",
      title: "External note",
      content_hash: null,
      metadata: {}
    }
  ];

  const manifest = await exportArtifacts({
    outputDir,
    workspaceId: "workspace:default",
    artifacts,
    openFile: async (artifact) => ({
      stream: Readable.from([artifact.id === "artifact:stored" ? bytes : ""]),
      size: bytes.length,
      contentType: "text/plain",
      fileName: "trace.txt"
    })
  });

  assert.equal(manifest.artifact_count, 2);
  assert.equal(manifest.exported_count, 1);
  assert.equal(manifest.artifacts[0].exported, true);
  assert.equal(manifest.artifacts[0].sha256, hash);
  assert.equal(manifest.artifacts[1].reason, "path-only artifact");
  assert.equal(
    await readFile(path.join(outputDir, "problem-launch", "artifact-stored-trace.txt"), "utf8"),
    bytes
  );
  const savedManifest = JSON.parse(await readFile(path.join(outputDir, "artifact-export-manifest.json"), "utf8"));
  assert.equal(savedManifest.exported_count, 1);

  await assert.rejects(
    () =>
      exportArtifacts({
        outputDir: path.join(tmp, "bad-export"),
        workspaceId: "workspace:default",
        artifacts: [{ ...artifacts[0], content_hash: `sha256:${"0".repeat(64)}` }],
        openFile: async () => ({
          stream: Readable.from([bytes]),
          size: bytes.length,
          contentType: "text/plain",
          fileName: "trace.txt"
        })
      }),
    /hash mismatch/
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

assert.equal(artifactExportPath({ id: "artifact:test", problem_id: "problem:test" }, "trace file.txt"), path.join("problem-test", "artifact-test-trace-file.txt"));
assert.deepEqual(parseArgs(["/tmp/out"]), { outputDir: "/tmp/out" });
assert.deepEqual(parseArgs(["--output-dir", "/tmp/out", "--workspace-id", "workspace:default"]), {
  outputDir: "/tmp/out",
  workspaceId: "workspace:default"
});
assert.throws(() => parseArgs(["--output-dir"]), /requires a value/);

console.log("artifact export checks passed.");
