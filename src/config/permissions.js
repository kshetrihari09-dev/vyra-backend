/**
 * Single source of truth for roles and permissions. `npm run seed:reference`
 * copies this into the roles / permissions / role_permissions tables (additive
 * and idempotent — it never removes a grant someone made at runtime).
 *
 * Customer-owned resources (my cart, my orders, my prescriptions) are NOT
 * permissions: they are ownership checks inside the services. Permissions are
 * for acting on other people's / the business's data.
 */

export const PERMISSIONS = {
  "catalog:write": "Create, edit and delete any product, category or brand",
  "catalog:price": "Change product prices",
  "catalog:write_own": "Manage own shop's product listings",
  "inventory:read": "View inventory, batches and stock movements",
  "inventory:adjust": "Adjust stock levels",
  "inventory:transfer": "Transfer stock between branches",
  "inventory:receive": "Receive purchased goods into stock",
  "orders:read_all": "View every order",
  "orders:update_status": "Move orders through fulfilment stages",
  "orders:cancel": "Cancel orders on a customer's behalf",
  "orders:refund": "Issue refunds",
  "prescriptions:read_all": "View every prescription",
  "prescriptions:review": "Approve or reject prescriptions",
  "customers:read": "View customer records",
  "sellers:read_all": "View every seller and shop application",
  "sellers:approve": "Approve, reject or suspend sellers and shop applications",
  "seller:manage_own": "Operate own seller account (products, orders, settings)",
  "payouts:request": "Request a payout for own seller account",
  "payouts:read_all": "View every seller payout",
  "payouts:approve": "Approve seller payouts",
  "purchases:read": "View purchase orders",
  "purchases:manage": "Create purchase orders",
  "delivery:manage": "Assign riders and manage delivery zones",
  "delivery:rider": "Perform rider operations (accept, pick up, deliver, share location)",
  "promotions:manage": "Manage coupons and promotions",
  "pos:sell": "Ring up point-of-sale transactions",
  "reports:read": "View business reports",
  "audit:read": "Read the audit log",
  "users:read": "View user accounts",
  "users:manage": "Suspend or reactivate user accounts",
  "roles:assign": "Assign roles to users",
  "settings:manage": "Manage system settings",
};

const ALL = Object.keys(PERMISSIONS);

/** Roles the UI treats as "staff" (may see back-office consoles). Display hint only — never used for authorization. */
export const STAFF_ROLES = ["admin", "pharmacist", "warehouse", "accountant", "delivery", "support"];

export const ROLES = {
  customer: { label: "Customer", description: "Shops on the storefront", permissions: [] },
  admin: { label: "Administrator", description: "Full access (the frontend's Owner and Administrator)", permissions: ALL },
  pharmacist: {
    label: "Pharmacist", description: "Reviews prescriptions, sees orders and batch stock",
    permissions: ["prescriptions:read_all", "prescriptions:review", "orders:read_all", "inventory:read", "pos:sell"],
  },
  seller: {
    label: "Seller", description: "Marketplace shop owner (which shop is decided by the database, never by the client)",
    permissions: ["seller:manage_own", "catalog:write_own", "payouts:request"],
  },
  delivery: { label: "Delivery partner", description: "Rider app", permissions: ["delivery:rider"] },
  warehouse: {
    label: "Warehouse / inventory", description: "Stock, purchasing and packing (the frontend's Inventory Manager)",
    permissions: ["inventory:read", "inventory:adjust", "inventory:transfer", "inventory:receive", "purchases:read", "purchases:manage", "orders:read_all", "orders:update_status"],
  },
  accountant: {
    label: "Accountant", description: "Payouts, refunds and reporting",
    permissions: ["payouts:read_all", "payouts:approve", "orders:read_all", "orders:refund", "reports:read", "purchases:read", "audit:read"],
  },
  support: {
    label: "Customer support", description: "Order and customer look-ups, refunds",
    permissions: ["orders:read_all", "orders:cancel", "orders:refund", "customers:read"],
  },
};

export const ROLE_KEYS = Object.keys(ROLES);
export const isStaffRole = (roles) => roles.some((r) => STAFF_ROLES.includes(r));
