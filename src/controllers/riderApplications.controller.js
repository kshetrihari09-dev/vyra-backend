import { badRequest } from "../utils/errors.js";
import { clientContext, ok } from "../utils/http.js";
import { MAX_UPLOAD_BYTES } from "../validators/riderApplications.validators.js";

/** Accepts a data URL or bare base64, rejects empty / oversized files (same rules as the other upload endpoints). */
function decodeDocuments(documents) {
  return documents.map((d) => {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(d.dataBase64);
    const buffer = Buffer.from(match ? match[2] : d.dataBase64, "base64");
    if (buffer.length === 0) throw badRequest("EMPTY_FILE", `${d.fileName} couldn't be read`);
    if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest("FILE_TOO_LARGE", `${d.fileName} must be under 5 MB`);
    return { type: d.type, fileName: d.fileName, mimeType: match ? match[1] : d.mimeType, buffer };
  });
}

export function createRiderApplicationsController({ services }) {
  const svc = services.riderApplications;
  const withFiles = (body) => ({ ...body, documents: decodeDocuments(body.documents) });
  return {
    async submit(req, res) { ok(res, { application: await svc.submit(req.auth.user, withFiles(req.valid.body), clientContext(req)) }, 201); },
    async listMine(req, res) { ok(res, { applications: await svc.listMine(req.auth.user) }); },
    async listAll(req, res) { ok(res, { applications: await svc.listAll(req.auth.user, req.valid.query) }); },
    async get(req, res) { ok(res, { application: await svc.get(req.auth.user, req.valid.params.id) }); },
    async decide(req, res) { ok(res, { application: await svc.decide(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async resubmit(req, res) { ok(res, { application: await svc.resubmit(req.auth.user, req.valid.params.id, withFiles(req.valid.body), clientContext(req)) }); },
    async documentFile(req, res) {
      const { buffer, mimeType, fileName } = await svc.getDocumentFile(req.auth.user, req.valid.params.id, req.valid.params.documentId);
      res.set("Content-Type", mimeType);
      res.set("Content-Disposition", `inline; filename="${fileName.replace(/"/g, "")}"`);
      res.set("Cache-Control", "private, max-age=0, no-store");
      res.set("X-Content-Type-Options", "nosniff");
      res.send(buffer);
    },
  };
}
