/** Consistent success envelope: { success: true, data } */
export const ok = (res, data = null, status = 200) => res.status(status).json({ success: true, data });

export const clientContext = (req) => ({
  ip: req.ip,
  userAgent: String(req.get("user-agent") || "").slice(0, 300),
  requestId: req.id,
});
