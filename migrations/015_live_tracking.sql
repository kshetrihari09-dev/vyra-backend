-- Live order tracking. Builds on Phase 7 (riders / deliveries / location trail) — nothing there is replaced.
--
-- The order id stays the single source of truth: a delivery already belongs to exactly one order, the order already knows its
-- customer (orders.user_id) and its sellers (order_items.seller_id), so those are JOINED in the `delivery_tracking` view
-- below instead of being copied onto the delivery row where they could drift.

-- ---------------------------------------------------------------------------------------------------
-- Where things are. Both are optional: a customer who hasn't pinned their address still gets status + ETA, just no map pin.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE addresses ADD COLUMN lat double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90);
ALTER TABLE addresses ADD COLUMN lng double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180);
ALTER TABLE addresses ADD CONSTRAINT addresses_latlng_pair CHECK ((lat IS NULL) = (lng IS NULL));

-- A branch is where an order is picked up. (Third-party seller stock lives on the shared branches, so pickup = branch.)
ALTER TABLE branches ADD COLUMN lat double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90);
ALTER TABLE branches ADD COLUMN lng double precision CHECK (lng IS NULL OR lng BETWEEN -180 AND 180);
ALTER TABLE branches ADD CONSTRAINT branches_latlng_pair CHECK ((lat IS NULL) = (lng IS NULL));

-- ---------------------------------------------------------------------------------------------------
-- A delivery snapshots both end points when it is opened (the customer may edit their address afterwards; a run must not
-- change destination mid-way) and carries the live ETA plus two progress timestamps the Phase 7 statuses didn't have:
--   arrived_pickup_at  rider reported arriving at the store (status is still `accepted`)
--   started_at         rider tapped "Start delivery" after pickup (status is still `picked_up`)
-- Keeping them as timestamps — rather than new `status` values — leaves every existing status check, index and the
-- one-active-delivery-per-order constraint exactly as they were.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE deliveries ADD COLUMN pickup_lat double precision CHECK (pickup_lat IS NULL OR pickup_lat BETWEEN -90 AND 90);
ALTER TABLE deliveries ADD COLUMN pickup_lng double precision CHECK (pickup_lng IS NULL OR pickup_lng BETWEEN -180 AND 180);
ALTER TABLE deliveries ADD COLUMN customer_lat double precision CHECK (customer_lat IS NULL OR customer_lat BETWEEN -90 AND 90);
ALTER TABLE deliveries ADD COLUMN customer_lng double precision CHECK (customer_lng IS NULL OR customer_lng BETWEEN -180 AND 180);
ALTER TABLE deliveries ADD COLUMN estimated_arrival timestamptz;
ALTER TABLE deliveries ADD COLUMN eta_updated_at timestamptz;
ALTER TABLE deliveries ADD COLUMN eta_source text CHECK (eta_source IS NULL OR eta_source IN ('route', 'estimate'));
ALTER TABLE deliveries ADD COLUMN arrived_pickup_at timestamptz;
ALTER TABLE deliveries ADD COLUMN started_at timestamptz;

-- ---------------------------------------------------------------------------------------------------
-- Rider photo (shown to the customer once a rider is assigned). Set by dispatch; https only.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE riders ADD COLUMN photo_url text CHECK (photo_url IS NULL OR (photo_url ~ '^https://' AND length(photo_url) <= 500));

-- ---------------------------------------------------------------------------------------------------
-- delivery_tracking: the tracking record under the names the feature spec uses. A VIEW, so it can never disagree with the
-- tables it reads from. Application code does not query it for authorisation — it is for reporting / support / ad-hoc SQL.
-- `seller_id` is the shop when ALL of the order's lines belong to one seller, else NULL (a shared basket).
-- Coordinates of a closed run are cleared (see delivery.repository purgeLocations), so they are NULL for finished deliveries.
-- ---------------------------------------------------------------------------------------------------
CREATE VIEW delivery_tracking AS
SELECT d.id                  AS delivery_id,
       d.order_id            AS order_id,
       (SELECT CASE WHEN count(DISTINCT oi.seller_id) = 1 AND bool_and(oi.seller_id IS NOT NULL) THEN min(oi.seller_id) END
          FROM order_items oi WHERE oi.order_id = o.id) AS seller_id,
       o.user_id             AS customer_id,
       d.rider_id            AS delivery_partner_id,
       d.pickup_lat          AS pickup_latitude,
       d.pickup_lng          AS pickup_longitude,
       d.customer_lat        AS customer_latitude,
       d.customer_lng        AS customer_longitude,
       d.last_lat            AS current_latitude,
       d.last_lng            AS current_longitude,
       d.status              AS delivery_status,
       o.status              AS order_status,
       d.estimated_arrival   AS estimated_arrival,
       d.last_located_at     AS last_location_update
  FROM deliveries d
  JOIN orders o ON o.id = d.order_id;
