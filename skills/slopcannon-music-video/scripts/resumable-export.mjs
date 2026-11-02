// Shared browser/CLI state machine. Byte access, hashing, credentials and durable
// journal writes belong to the caller; no Node imports or third-party packages.
const conflict = () => new Error("The saved export does not match the original upload. Preserve its file and journal.");
const hashPattern = /^[a-f0-9]{64}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function json(fetcher, url, init) {
  const response = await fetcher(url, init);
  const reader = response.body?.getReader();
  let text = "", length = 0;
  const decoder = new TextDecoder();
  try {
    if (reader) for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 64 * 1024) throw new Error("Export response exceeds its metadata limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); } }
  let body; try { body = JSON.parse(text); } catch { throw new Error(`Export transport returned invalid metadata (${response.status}). Keep its original key.`); }
  if (!response.ok) {
    const error = new Error(`Export upload returned ${response.status}: ${body.error?.message ?? "retry the same saved upload"}`);
    error.status = response.status; error.code = body.error?.code;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return body.data;
}

/** @typedef {{projectId:string, filename:string, contentType:string, sizeBytes:number, sha256:string}} ExportManifest */
/** @typedef {{version:1, url:string, key:string, rights:string, manifest:ExportManifest, sessionId?:string}} ExportJournal */

/** Readiness is authenticated and app-owned. A saved journal does not need new
 * intake readiness; it goes directly to its original recovery endpoint. */
export async function readExportReadiness(fetcher, url, requestOptions = {}) {
  const data = await json(fetcher, `${url}/readiness`, { ...requestOptions, method: "GET" });
  if (!data || typeof data.newUploads !== "boolean" || typeof data.recoveryAvailable !== "boolean" ||
      data.partSize !== 32 * 1024 ** 2 || data.maxBytes !== 4 * 1024 ** 3) throw conflict();
  return data;
}

/**
 * @param {{journal:ExportJournal, manifest:ExportManifest, url:string, purpose?:"final_export"|"source_video",
 * fetch:typeof globalThis.fetch, requestOptions?:RequestInit,
 * current:()=>void, save:(journal:ExportJournal)=>void,
 * readPart:(start:number,end:number)=>Promise<Blob|Uint8Array>,
 * hashPart:(part:Blob|Uint8Array)=>Promise<string>}} input
 */
export async function resumeExportUpload(input) {
  const journal = structuredClone(input.journal), manifest = input.manifest;
  const sourceVideo = input.purpose === "source_video";
  if (journal.version !== 1 || journal.url !== input.url || !same(journal.manifest, manifest) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:~-]{15,199}$/.test(journal.key) || !journal.rights ||
      !hashPattern.test(manifest.sha256) || !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0 ||
      manifest.sizeBytes > (sourceVideo ? 500 * 1024 ** 2 : 4 * 1024 ** 3) ||
      !(sourceVideo ? ["video/mp4", "video/quicktime"].includes(manifest.contentType) : manifest.contentType === "video/mp4")) throw conflict();
  const headers = new Headers(input.requestOptions?.headers);
  headers.set("X-Slopcannon-Rights-Attestation", journal.rights);
  const call = async (path, method = "GET", body, extra = {}) => {
    input.current();
    const h = new Headers(headers); for (const [key, value] of Object.entries(extra)) h.set(key, value);
    const data = await json(input.fetch, `${journal.url}${path}`, {
      ...input.requestOptions, method, headers: h, ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(method === "POST" && path.endsWith("/finish") ? 300_000 : 120_000),
    });
    input.current(); return data;
  };
  const validate = session => {
    if (!session || !/^upl_[a-f0-9]{64}$/.test(session.id) || !/^exp_[a-f0-9]{64}$/.test(session.assetId) || session.assetId !== `exp_${session.id.slice(4)}` ||
        session.projectId !== manifest.projectId || session.filename !== manifest.filename ||
        session.contentType !== manifest.contentType || session.sha256 !== manifest.sha256 || session.sizeBytes !== manifest.sizeBytes ||
        (sourceVideo ? session.purpose !== "source_video" : session.purpose !== undefined && session.purpose !== "final_export") ||
        session.partSize !== 32 * 1024 ** 2 || (journal.sessionId && session.id !== journal.sessionId) ||
        !["uploading", "finalizing", "complete", "aborting", "aborted"].includes(session.state)) throw conflict();
    return session;
  };
  if (!journal.sessionId) {
    const begun = validate(await call("", "POST", JSON.stringify(manifest), { "Content-Type": "application/json", "Idempotency-Key": journal.key }));
    journal.sessionId = begun.id; input.save(structuredClone(journal)); input.current();
  } else if (!/^upl_[a-f0-9]{64}$/.test(journal.sessionId)) throw conflict();
  const path = `/${journal.sessionId}`;
  let session = validate(await call(path));
  if (session.state === "aborting" || session.state === "aborted") throw new Error("This saved upload was canceled. Keep the original master; it cannot be resumed under another identity automatically.");
  if (session.state === "uploading") {
    if (!Array.isArray(session.parts) || session.parts.length > 128) throw conflict();
    const parts = new Map();
    for (const p of session.parts) {
      if (!Number.isInteger(p.partNumber) || p.partNumber < 1 || p.partNumber > Math.ceil(manifest.sizeBytes / session.partSize) ||
          parts.has(p.partNumber) || !hashPattern.test(p.sha256) ||
          p.sizeBytes !== Math.min(session.partSize, manifest.sizeBytes - (p.partNumber - 1) * session.partSize) ||
          (p.storedAt !== null && (!Number.isSafeInteger(p.storedAt) || p.storedAt < 0))) throw conflict();
      parts.set(p.partNumber, p);
    }
    for (let start = 0, number = 1; start < manifest.sizeBytes; start += session.partSize, number++) {
      input.current();
      const end = Math.min(start + session.partSize, manifest.sizeBytes), bytes = await input.readPart(start, end);
      input.current();
      if ((bytes instanceof Uint8Array ? bytes.byteLength : bytes.size) !== end - start) throw conflict();
      const sha256 = await input.hashPart(bytes); input.current();
      if (!hashPattern.test(sha256)) throw conflict();
      const stored = parts.get(number);
      if (stored && stored.sha256 !== sha256) throw conflict();
      if (stored?.storedAt != null) continue;
      const receipt = await call(`${path}/parts/${number}`, "PUT", bytes, {
        "Content-Type": "application/octet-stream", "Content-Range": `bytes ${start}-${end - 1}/${manifest.sizeBytes}`, "X-Content-SHA256": sha256,
      });
      if (receipt?.partNumber !== number || receipt.sha256 !== sha256 || receipt.sizeBytes !== end - start) throw conflict();
    }
  }
  if (session.state !== "complete") {
    validate(await call(`${path}/finish`, "POST", "{}", { "Content-Type": "application/json" }));
    session = validate(await call(path));
  }
  if (session.state !== "complete" || typeof session.downloadUrl !== "string" || !session.downloadUrl.endsWith(`/assets/${session.assetId}`))
    throw new Error("The original export has no available published master. Preserve its file and upload journal.");
  return { id: session.assetId, ...manifest, kind: sourceVideo ? "other" : "final_export" };
}
