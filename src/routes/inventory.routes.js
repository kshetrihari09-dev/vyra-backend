import { Router } from "express";
import { authenticate, requirePermission } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import * as v from "../validators/inventory.validators.js";

/** Everything here needs inventory:adjust — this is where real stock changes happen. Reads (movements, low-stock,
    suppliers/PO list) are open to any authenticated staff member with the permission, no finer split for now. */
export function inventoryRoutes({ container, controller }) {
  const r = Router();
  const authed = authenticate(container);
  const write = requirePermission("inventory:adjust");

  r.post("/inventory/adjust", authed, write, validate({ body: v.adjustBody }), controller.adjust);
  r.post("/inventory/transfer", authed, write, validate({ body: v.transferBody }), controller.transfer);
  r.get("/inventory/movements", authed, write, validate({ query: v.movementsQuery }), controller.movements);
  r.get("/inventory/low-stock", authed, write, validate({ query: v.lowStockQuery }), controller.lowStock);

  r.get("/suppliers", authed, write, controller.listSuppliers);
  r.get("/purchase-orders", authed, write, controller.listPurchaseOrders);
  r.post("/purchase-orders", authed, write, validate({ body: v.createPOBody }), controller.createPurchaseOrder);
  r.post("/purchase-orders/:id/receive", authed, write, validate({ params: v.poIdParams, body: v.receivePOBody }), controller.receivePurchaseOrder);

  r.post("/pos/sale", authed, write, validate({ body: v.posSaleBody }), controller.posSale);
  return r;
}
