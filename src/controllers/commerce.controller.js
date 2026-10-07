import { clientContext, ok } from "../utils/http.js";

export function createCommerceController({ services, config }) {
  const { addresses, cart, orders, wishlist } = services;
  return {
    // addresses
    async listAddresses(req, res) { ok(res, { addresses: await addresses.list(req.auth.user.id) }); },
    async createAddress(req, res) { ok(res, { address: await addresses.create(req.auth.user.id, req.valid.body, clientContext(req)) }, 201); },
    async updateAddress(req, res) { ok(res, { address: await addresses.update(req.auth.user.id, req.valid.params.id, req.valid.body, clientContext(req)) }); },
    async setDefaultAddress(req, res) { ok(res, { address: await addresses.setDefault(req.auth.user.id, req.valid.params.id) }); },
    async startAddressPhone(req, res) {
      const data = await addresses.startPhoneVerification(req.auth.user.id, req.valid.body.phone, clientContext(req));
      const body = { ...data };
      if (!data.verified && config?.otp?.devCode) body.devHint = "Development OTP is active"; // never the code itself
      ok(res, body);
    },
    async verifyAddressPhone(req, res) { ok(res, await addresses.verifyPhone(req.auth.user.id, req.valid.body, clientContext(req))); },
    async removeAddress(req, res) { ok(res, await addresses.remove(req.auth.user.id, req.valid.params.id, clientContext(req))); },

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
