-- Vyra's own first-party shop ("Vyra Center") must always exist so administrators can open and manage it from the
-- seller console and assign products to it. Production databases that never ran the demo seed had no such row.
INSERT INTO sellers (id, name, first_party, status, commission_rate, contact_email, payout_method_label)
VALUES ('vyra-retail', 'Vyra Center', true, 'active', 0, 'ops@vyra.com', 'N/A — first-party')
ON CONFLICT (id) DO UPDATE SET name = 'Vyra Center', first_party = true, status = 'active', commission_rate = 0;
