import { badRequest } from "../utils/errors.js";
import { clientContext, ok } from "../utils/http.js";
import { MAX_UPLOAD_BYTES } from "../validators/prescriptions.validators.js";

/** Accepts a data URL ("data:image/jpeg;base64,...") or a bare base64 string — the browser's FileReader
    already produces the former, so the frontend can send its `value.fileUrl` straight through unchanged. */
function decodeUpload(dataBase64, declaredMimeType) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataBase64);
  const mimeType = match ? match[1] : declaredMimeType;
  const buffer = Buffer.from(match ? match[2] : dataBase64, "base64");
  if (buffer.length === 0) throw badRequest("EMPTY_FILE", "That file couldn't be read");
  if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest("FILE_TOO_LARGE", "File must be under 10 MB");
  return { buffer, mimeType };
}

export function createPrescriptionsController({ services }) {
  const { prescriptions } = services;
  return {
    async upload(req, res) {
      const { fileName, mimeType: declaredMimeType, dataBase64, productIds } = req.valid.body;
      const { buffer, mimeType } = decodeUpload(dataBase64, declaredMimeType);
      const rx = await prescriptions.upload(req.auth.user, { fileName, mimeType, buffer, productIds }, clientContext(req));
      ok(res, { prescription: rx }, 201);
    },
    async listMine(req, res) { ok(res, { prescriptions: await prescriptions.listMine(req.auth.user) }); },
    async listAll(req, res) { ok(res, { prescriptions: await prescriptions.listAll(req.auth.user, req.valid.query) }); },
    async get(req, res) { ok(res, { prescription: await prescriptions.get(req.auth.user, req.valid.params.id) }); },
    async review(req, res) { ok(res, { prescription: await prescriptions.review(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async file(req, res) {
      const { buffer, mimeType, fileName } = await prescriptions.getFile(req.auth.user, req.valid.params.id);
      res.set("Content-Type", mimeType);
      res.set("Content-Disposition", `inline; filename="${fileName.replace(/"/g, "")}"`);
      res.set("Cache-Control", "private, max-age=0, no-store"); // never cached by a shared/public cache
      res.send(buffer);
    },
  };
}
