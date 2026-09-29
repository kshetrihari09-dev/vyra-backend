import { badRequest } from "../utils/errors.js";
import { clientContext, ok } from "../utils/http.js";
import { MAX_UPLOAD_BYTES } from "../validators/sellerApplications.validators.js";

/** Same data-URL-or-bare-base64 acceptance as prescriptions, applied to every document in the array. */
function decodeDocuments(documents) {
  return (documents ?? []).map((d) => {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(d.dataBase64);
    const mimeType = match ? match[1] : d.mimeType;
    const buffer = Buffer.from(match ? match[2] : d.dataBase64, "base64");
    if (buffer.length === 0) throw badRequest("EMPTY_FILE", `${d.fileName} couldn't be read`);
    if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest("FILE_TOO_LARGE", `${d.fileName} must be under 5 MB`);
    return { type: d.type, fileName: d.fileName, mimeType, buffer };
  });
}

export function createSellerApplicationsController({ services }) {
  const { sellerApplications } = services;
  return {
    async submit(req, res) {
      const body = { ...req.valid.body, documents: decodeDocuments(req.valid.body.documents) };
      const application = await sellerApplications.submit(req.auth.user, body, clientContext(req));
      ok(res, { application }, 201);
    },
    async listMine(req, res) { ok(res, { applications: await sellerApplications.listMine(req.auth.user) }); },
    async listAll(req, res) { ok(res, { applications: await sellerApplications.listAll(req.auth.user, req.valid.query) }); },
    async get(req, res) { ok(res, { application: await sellerApplications.get(req.auth.user, req.valid.params.id) }); },
    async getSettlement(req, res) { ok(res, await sellerApplications.getSettlement(req.auth.user, req.valid.params.id)); },
    async decide(req, res) { ok(res, { application: await sellerApplications.decide(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async resubmit(req, res) {
      const body = { ...req.valid.body, documents: req.valid.body.documents ? decodeDocuments(req.valid.body.documents) : undefined };
      ok(res, { application: await sellerApplications.resubmit(req.auth.user, req.valid.params.id, body, clientContext(req)) });
    },
    async verifyDocument(req, res) {
      ok(res, { document: await sellerApplications.verifyDocument(req.auth.user, req.valid.params.id, req.valid.params.documentId, req.valid.body, clientContext(req)) });
    },
    async documentFile(req, res) {
      const { buffer, mimeType, fileName } = await sellerApplications.getDocumentFile(req.auth.user, req.valid.params.id, req.valid.params.documentId);
      res.set("Content-Type", mimeType);
      res.set("Content-Disposition", `inline; filename="${fileName.replace(/"/g, "")}"`);
      res.set("Cache-Control", "private, max-age=0, no-store");
      res.send(buffer);
    },
  };
}
