import { Router } from "express";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/inventory.validators.js";

/** Everything here needs inventory:adjust — this is where real stock changes happen. Reads (movements, low-stock,
    suppliers/PO list) are open to any authenticated staff member with the permission, no finer split for now. */
export function inventoryRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);
  const write = requirePermission("inventory:adjust");

  // Shop owners adjust stock on their own listings only — the service enforces ownership.
  r.post("/inventory/adjust", authed, requireAnyPermission("inventory:adjust", "catalog:write_own"), validate({ body: v.adjustBody }), controller.adjust);
  r.post("/inventory/transfer", authed, write, validate({ body: v.transferBody }), controller.transfer);
  r.get("/inventory/movements", authed, write, validate({ query: v.movementsQuery }), controller.movements);
  r.get("/inventory/low-stock", authed, write, validate({ query: v.lowStockQuery }), controller.lowStock);

  r.get("/suppliers", authed, write, controller.listSuppliers);
  r.get("/purchase-orders", authed, write, controller.listPurchaseOrders);
  r.post("/purchase-orders", authed, write, validate({ body: v.createPOBody }), controller.createPurchaseOrder);
  r.post("/purchase-orders/:id/receive", authed, write, validate({ params: v.poIdParams, body: v.receivePOBody }), controller.receivePurchaseOrder);

  // The till is guarded by pos:sell (what the pharmacist role actually holds) — not inventory:adjust, which is a stock-keeper's right.
  const sell = requirePermission("pos:sell");
  r.post("/pos/sale", authed, sell, validate({ body: v.posSaleBody }), controller.posSale);
  r.get("/pos/sales", authed, sell, validate({ query: v.posSalesQuery }), controller.listPosSales);
  r.get("/pos/sales/by-key/:key", authed, sell, validate({ params: v.posSaleKeyParams }), controller.getPosSaleByKey); // before :id
  r.get("/pos/sales/:id", authed, sell, validate({ params: v.posSaleIdParams }), controller.getPosSale);
  return r;
}
