import { toNumber } from "../utils/text.js";

export const toSellerDto = (r) => ({
  id: r.id, name: r.name, firstParty: r.first_party, status: r.status,
  commissionRate: toNumber(r.commission_rate), rating: r.rating == null ? null : toNumber(r.rating),
  reviewsCount: r.reviews_count, ownerUserId: r.owner_user_id ?? null,
  contactEmail: r.contact_email ?? null, contactMobile: r.contact_mobile ?? null,
  payoutMethodLabel: r.payout_method_label ?? null, joinedAt: r.joined_at,
});
