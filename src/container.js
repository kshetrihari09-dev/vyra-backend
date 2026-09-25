import { createPool, withTransaction } from "./db/pool.js";
import { createAuditRepository } from "./repositories/audit.repository.js";
import { createCatalogRepository } from "./repositories/catalog.repository.js";
import { createAddressesRepository } from "./repositories/addresses.repository.js";
import { createCouponsRepository } from "./repositories/coupons.repository.js";
import { createInventoryRepository } from "./repositories/inventory.repository.js";
import { createOrdersRepository } from "./repositories/orders.repository.js";
import { createPurchasingRepository } from "./repositories/purchasing.repository.js";
import { createProductsRepository } from "./repositories/products.repository.js";
import { createWishlistRepository } from "./repositories/wishlist.repository.js";
import { createRolesRepository } from "./repositories/roles.repository.js";
import { createSessionsRepository } from "./repositories/sessions.repository.js";
import { createUsersRepository } from "./repositories/users.repository.js";
import { createAuditService } from "./services/audit.service.js";
import { createAuthService } from "./services/auth.service.js";
import { createCatalogService } from "./services/catalog.service.js";
import { createNotifier } from "./services/notifier.js";
import { createAddressesService } from "./services/addresses.service.js";
import { createCartService } from "./services/cart.service.js";
import { createCouponsService } from "./services/coupons.service.js";
import { createInventoryService } from "./services/inventory.service.js";
import { createOrdersService } from "./services/orders.service.js";
import { createPurchasingService } from "./services/purchasing.service.js";
import { createPricingService } from "./services/pricing.service.js";
import { createProductsService } from "./services/products.service.js";
import { createWishlistService } from "./services/wishlist.service.js";
import { createSearchService } from "./services/search.service.js";
import { createUsersService } from "./services/users.service.js";
import { createLogger } from "./utils/logger.js";
import { createPasswordHasher } from "./utils/password.js";
import { createTokenService } from "./utils/tokens.js";

/**
 * Composition root: the only place that wires concrete implementations together.
 * Later phases add their repositories/services here (catalog, orders, inventory, ...).
 */
export function createContainer(config, overrides = {}) {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const pool = overrides.pool ?? createPool(config, logger);
  const withTx = (fn) => withTransaction(pool, fn);

  const repos = {
    users: createUsersRepository(),
    roles: createRolesRepository(),
    sessions: createSessionsRepository(),
    audit: createAuditRepository(),
    catalog: createCatalogRepository(),
    products: createProductsRepository(),
    addresses: createAddressesRepository(),
    coupons: createCouponsRepository(),
    inventory: createInventoryRepository(),
    orders: createOrdersRepository(),
    wishlist: createWishlistRepository(),
    purchasing: createPurchasingRepository(),
  };
  const tokens = createTokenService({ secret: config.auth.jwtSecret, ttlSeconds: config.auth.accessTtlSeconds });
  const notifier = createNotifier({ driver: config.notify.driver, logger });
  const audit = createAuditService({ repo: repos.audit, pool });

  const services = {
    audit,
    auth: createAuthService({ config, pool, withTx, repos, hasher: createPasswordHasher(), tokens, notifier, audit }),
    users: createUsersService({ pool, withTx, repos, audit }),
    catalog: createCatalogService({ pool, withTx, repos, audit }),
    products: createProductsService({ pool, withTx, repos, audit }),
    search: createSearchService({ pool, repos }),
    addresses: createAddressesService({ pool, withTx, repos }),
    wishlist: createWishlistService({ pool, repos }),
  };
  const coupons = createCouponsService({ repos });
  const pricing = createPricingService({ repos, coupons });
  services.cart = createCartService({ pool, repos, pricing });
  services.orders = createOrdersService({ pool, withTx, repos, pricing, audit });
  services.inventory = createInventoryService({ pool, withTx, repos, audit });
  services.purchasing = createPurchasingService({ pool, withTx, repos, audit });

  return { config, logger, pool, withTx, repos, tokens, services };
}
