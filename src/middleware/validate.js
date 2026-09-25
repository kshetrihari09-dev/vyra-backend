import { AppError } from "../utils/errors.js";

/**
 * validate({ body, query, params }) with zod schemas. Parsed (and coerced/stripped) values land on req.valid.*;
 * handlers must read from there, never from the raw req.body.
 */
export const validate = (schemas) => (req, _res, next) => {
  const valid = {};
  const issues = [];
  for (const part of ["params", "query", "body"]) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (result.success) valid[part] = result.data;
    else issues.push(...result.error.issues.map((i) => ({ path: [part, ...i.path].join("."), message: i.message })));
  }
  if (issues.length) return next(new AppError(400, "VALIDATION_ERROR", issues[0].message, issues));
  req.valid = valid;
  next();
};
