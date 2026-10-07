-- Distance-based delivery charge. The fee itself was already stored per order (orders.delivery_fee) — it is a SNAPSHOT, so
-- changing the tier table later never re-prices an old order. This adds the distance that fee was based on, so a support
-- agent can answer "why was I charged this?" from the order alone. NULL = distance unknown when the order was placed
-- (the address had no map pin, or the branch has no location) — the fallback fee applied.
ALTER TABLE orders ADD COLUMN delivery_distance_km numeric(6, 2) CHECK (delivery_distance_km IS NULL OR delivery_distance_km >= 0);
