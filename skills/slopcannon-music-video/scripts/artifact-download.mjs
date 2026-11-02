import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export async function fileDigest(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function verifiedLocalArtifact(artifact) {
  if (!artifact?.path || !Number.isSafeInteger(artifact.bytes) || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) return false;
  try {
    const actual = await fileDigest(artifact.path);
    return actual.bytes === artifact.bytes && actual.sha256 === artifact.sha256;
  } catch { return false; }
}

/** Constant-memory transfer. A failed/partial response never replaces an existing file. */
export async function saveArtifactResponse(response, destination, artifact = {}, maxBytes = MAX_ARTIFACT_BYTES) {
  let temporary;
  let file;
  try {
    if (response.status !== 200 || !response.body) throw new Error(`Artifact download requires a full 200 response, received ${response.status}.`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 12) throw new Error("Invalid artifact byte ceiling.");
    const declared = response.headers.get("content-length");
    if (declared !== null && !/^\d+$/.test(declared)) throw new Error("Invalid artifact Content-Length.");
    const length = declared === null ? null : Number(declared);
    for (const expected of [length, artifact.bytes ?? null]) {
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 12 || expected > maxBytes)) throw new Error("Artifact byte count is outside the safe download limit.");
    }
    if (artifact.sha256 != null && !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Invalid server artifact digest.");
    temporary = `${destination}.partial-${randomUUID()}`;
    file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes || (length !== null && bytes > length) || (artifact.bytes != null && bytes > artifact.bytes)) throw new Error("Artifact exceeded its declared size or download ceiling.");
      if (prefix.length < 12) prefix = Buffer.concat([prefix, Buffer.from(chunk).subarray(0, 12 - prefix.length)]);
      hash.update(chunk);
      // FileHandle.write is permitted to write fewer bytes than requested.
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await file.write(chunk, offset, chunk.byteLength - offset);
        if (written.bytesWritten === 0) throw new Error("Artifact file write made no progress.");
        offset += written.bytesWritten;
      }
    }
    if (prefix.length < 12 || prefix.toString("ascii", 4, 8) !== "ftyp") throw new Error("Downloaded body is not an MP4 file.");
    if ((length !== null && bytes !== length) || (artifact.bytes != null && bytes !== artifact.bytes)) throw new Error("Artifact byte count does not match the completed download.");
    const sha256 = hash.digest("hex");
    if (artifact.sha256 != null && artifact.sha256 !== sha256) throw new Error("Artifact SHA-256 does not match the server digest.");
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, destination);
    temporary = null;
    return { path: destination, bytes, sha256, verifiedAgainstServer: Boolean(artifact.sha256) };
  } finally {
    if (file) await file.close();
    if (temporary) await unlink(temporary).catch(() => {});
    if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
  }
}
