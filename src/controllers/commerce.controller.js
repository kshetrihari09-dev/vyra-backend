import { clientContext, ok } from "../utils/http.js";

export function createCommerceController({ services }) {
  const { addresses, cart, orders, wishlist } = services;
  return {
    // addresses
    async listAddresses(req, res) { ok(res, { addresses: await addresses.list(req.auth.user.id) }); },
    async createAddress(req, res) { ok(res, { address: await addresses.create(req.auth.user.id, req.valid.body) }, 201); },
    async updateAddress(req, res) { ok(res, { address: await addresses.update(req.auth.user.id, req.valid.params.id, req.valid.body) }); },
    async setDefaultAddress(req, res) { ok(res, { address: await addresses.setDefault(req.auth.user.id, req.valid.params.id) }); },
    async removeAddress(req, res) { ok(res, await addresses.remove(req.auth.user.id, req.valid.params.id)); },

    // cart
    async priceCart(req, res) { ok(res, await cart.price(req.valid.body, req.auth?.user)); },

    // orders
    async listOrders(req, res) { ok(res, { orders: await orders.list(req.auth.user, req.valid.query) }); },
    async getOrder(req, res) { ok(res, { order: await orders.get(req.auth.user, req.valid.params.id) }); },
    async createOrder(req, res) { ok(res, { order: await orders.create(req.auth.user, req.valid.body, clientContext(req)) }, 201); },
    async advanceOrder(req, res) { ok(res, { order: await orders.advance(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async cancelOrder(req, res) { ok(res, { order: await orders.cancel(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) }); },

    // wishlist
    async listWishlist(req, res) { ok(res, { productIds: await wishlist.list(req.auth.user.id) }); },
    async toggleWishlist(req, res) { ok(res, await wishlist.toggle(req.auth.user.id, req.valid.params.productId)); },
  };
}
