/** Lower-case + trim, the normalisation every search comparison uses. */
export const normTerm = (s) => String(s ?? "").toLowerCase().trim();

/** Escapes LIKE metacharacters so user input is matched literally (backslash is Postgres' default LIKE escape). */
export const escapeLike = (s) => String(s).replace(/[\\%_]/g, "\\$&");

/** "Extra Virgin Olive Oil (1L)" -> "extra-virgin-olive-oil-1l". */
export const slugify = (s, max = 80) =>
  String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");

/** Money round-trip: pg returns numeric as string; the API speaks numbers with at most 2 decimals. */
export const toNumber = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);

/** Rounds to 2 decimal places — the money-math convention used throughout pricing/orders. */
export const round2 = (n) => Math.round(n * 100) / 100;
