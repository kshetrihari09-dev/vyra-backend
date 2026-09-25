import { Router } from "express";

export function healthRoutes({ pool }) {
  const r = Router();
  r.get("/", (_req, res) => res.json({ success: true, data: { status: "ok" } }));
  r.get("/ready", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ success: true, data: { status: "ready" } });
    } catch {
      res.status(503).json({ success: false, message: "Database unavailable", code: "NOT_READY" });
    }
  });
  return r;
}
