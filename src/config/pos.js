/** Point-of-sale rules. The server is the only authority for money: the browser sends WHAT is being sold, never what it costs. */

/** Methods a cashier can take at the counter. (The storefront's COD/net-banking don't apply at a till; credit needs a customer ledger, which this system does not have.) */
export const POS_PAYMENT_METHODS = ["cash", "card", "upi"];

/** A cashier may discount up to this share of the sale on their own; more needs the `catalog:price` permission (the existing "may change prices" right). */
export const MAX_CASHIER_DISCOUNT_PERCENT = 20;

/** Largest single line quantity / cash tendered the till accepts (typo guard, not a business limit). */
export const MAX_LINE_QTY = 10_000;
export const MAX_AMOUNT = 10_000_000;
