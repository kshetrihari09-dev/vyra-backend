import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Private object storage for prescription uploads (finding #9 / decision D8's storage half). Nothing here is
 * ever public: files are fetched only through a short-lived signed URL/token checked by the server, never a
 * direct static path.
 *
 * Two drivers behind the same interface ({ putObject, getObject, deleteObject, signDownload, verifyDownload }):
 *   - "local": writes under var/private-uploads/. Used whenever STORAGE_BUCKET isn't set — i.e. always in this
 *     sandbox (no network to a real bucket) and a reasonable default for a single-node deployment.
 *   - "s3": AWS Signature V4, hand-rolled with node:crypto so the dependency list doesn't grow. Selected once
 *     STORAGE_BUCKET/STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY are configured. Written carefully but, like the SQL
 *     in every migration so far, never executed here — there is no network path to S3 in this sandbox. Test
 *     against a real bucket (or MinIO) before trusting it in production.
 */
export function createStorageService(config) {
  const secret = config.auth.jwtSecret; // already validated (>=32 chars, not a placeholder) — reused rather than adding a new required env var
  const sign = (key, expiresAt) => createHmac("sha256", secret).update(`${key}.${expiresAt}`).digest("hex");

  function signDownload(key, ttlSeconds = 300) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    return { token: `${expiresAt}.${sign(key, expiresAt)}`, expiresAt };
  }
  function verifyDownload(key, token) {
    const [expiresAtStr, sig] = String(token || "").split(".");
    const expiresAt = Number(expiresAtStr);
    if (!expiresAt || !sig || Date.now() > expiresAt) return false;
    const expected = sign(key, expiresAt);
    return expected.length === sig.length && expected === sig; // both are fixed-length hex; a plain compare is fine here (not a login secret)
  }

  if (config.storage.bucket) {
    return createS3Driver(config.storage, { signDownload, verifyDownload });
  }
  return createLocalDriver({ signDownload, verifyDownload });
}

function createLocalDriver({ signDownload, verifyDownload }) {
  const root = path.join(process.cwd(), "var", "private-uploads");
  const resolve = (key) => {
    // Keys are server-generated UUIDs (see prescriptions.service.js) — this guard exists purely so a future
    // caller can never turn a crafted key into a path-traversal read.
    if (key.includes("..") || key.includes("/") || key.includes("\\")) throw new Error("Invalid storage key");
    return path.join(root, key);
  };
  return {
    driver: "local",
    async putObject(key, buffer) {
      await mkdir(root, { recursive: true });
      await writeFile(resolve(key), buffer);
    },
    async getObject(key) {
      return readFile(resolve(key));
    },
    async deleteObject(key) {
      await rm(resolve(key), { force: true });
    },
    signDownload,
    verifyDownload,
  };
}

/** AWS Signature V4 for a single-region S3-compatible bucket. PUT/GET only — everything this app needs. */
function createS3Driver({ bucket, region, endpoint, accessKey, secretKey }, { signDownload, verifyDownload }) {
  const host = endpoint ? new URL(endpoint).host : `${bucket}.s3.${region}.amazonaws.com`;
  const base = endpoint ? `${endpoint.replace(/\/+$/, "")}/${bucket}` : `https://${host}`;

  const hash = (buf) => createHash("sha256").update(buf).digest("hex");
  const hmac = (key, msg) => createHmac("sha256", key).update(msg, "utf8").digest();
  const amzDate = () => new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");

  function signingKey(dateStamp) {
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, "s3");
    return hmac(kService, "aws4_request");
  }

  /** Builds a fully-signed request (headers) for a given method/key/body — used directly rather than as a
      presigned URL, since the server itself is the only thing that ever reads/writes this bucket. */
  function signedRequest(method, key, body = Buffer.alloc(0)) {
    const date = amzDate();
    const dateStamp = date.slice(0, 8);
    const payloadHash = hash(body);
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [method, `/${key}`, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", date, scope, hash(Buffer.from(canonicalRequest))].join("\n");
    const signature = hmac(signingKey(dateStamp), stringToSign).toString("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return {
      url: `${base}/${key}`,
      headers: { host, "x-amz-content-sha256": payloadHash, "x-amz-date": date, authorization },
    };
  }

  return {
    driver: "s3",
    async putObject(key, buffer) {
      const req = signedRequest("PUT", key, buffer);
      const res = await fetch(req.url, { method: "PUT", headers: req.headers, body: buffer });
      if (!res.ok) throw new Error(`S3 PUT failed: ${res.status} ${await res.text().catch(() => "")}`);
    },
    async getObject(key) {
      const req = signedRequest("GET", key);
      const res = await fetch(req.url, { headers: req.headers });
      if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async deleteObject(key) {
      const req = signedRequest("DELETE", key);
      await fetch(req.url, { method: "DELETE", headers: req.headers });
    },
    signDownload,
    verifyDownload,
  };
}

export const newStorageKey = () => randomUUID();
