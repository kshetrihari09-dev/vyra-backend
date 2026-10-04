-- Product photos used to be written to the server's local disk (var/private-uploads/). On hosts with an ephemeral
-- filesystem (Render, Railway, Heroku...) that disk is wiped on every restart/redeploy, so the product_images rows
-- survived but the files did not: the photo only showed on the uploader's device (still holding the data URL in
-- memory) and every other device got a 404. Photos now live in Postgres, so they persist and are served to everyone.
-- Photos uploaded before this migration were lost with the disk; sellers need to re-upload those.

CREATE TABLE product_image_blobs (
  storage_key text PRIMARY KEY,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
