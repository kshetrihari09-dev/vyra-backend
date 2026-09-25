import { clientContext, ok } from "../utils/http.js";

export function createInventoryController({ services }) {
  const { inventory, purchasing } = services;
  return {
    async adjust(req, res) { ok(res, { movement: await inventory.adjust(req.auth.user, req.valid.body, clientContext(req)) }, 201); },
    async transfer(req, res) { ok(res, await inventory.transfer(req.auth.user, req.valid.body, clientContext(req)), 201); },
    async movements(req, res) { ok(res, { movements: await inventory.movements(req.valid.query) }); },
    async lowStock(req, res) { ok(res, { items: await inventory.lowStock(req.valid.query) }); },

    async listSuppliers(req, res) { ok(res, { suppliers: await purchasing.listSuppliers() }); },
    async listPurchaseOrders(req, res) { ok(res, { purchaseOrders: await purchasing.listPurchaseOrders(req.valid.query) }); },
    async createPurchaseOrder(req, res) { ok(res, { purchaseOrder: await purchasing.createPurchaseOrder(req.auth.user, req.valid.body, clientContext(req)) }, 201); },
    async receivePurchaseOrder(req, res) { ok(res, { purchaseOrder: await purchasing.receivePurchaseOrder(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },

    async posSale(req, res) { ok(res, { sale: await purchasing.posSale(req.auth.user, req.valid.body, clientContext(req)) }, 201); },
  };
}
