import { createPool, withTransaction } from "./db/pool.js";
import { createAuditRepository } from "./repositories/audit.repository.js";
import { createCatalogRepository } from "./repositories/catalog.repository.js";
import { createAddressesRepository } from "./repositories/addresses.repository.js";
import { createCouponsRepository } from "./repositories/coupons.repository.js";
import { createInventoryRepository } from "./repositories/inventory.repository.js";
import { createOrdersRepository } from "./repositories/orders.repository.js";
import { createPurchasingRepository } from "./repositories/purchasing.repository.js";
import { createProductsRepository } from "./repositories/products.repository.js";
import { createPaymentsRepository } from "./repositories/payments.repository.js";
import { createPrescriptionsRepository } from "./repositories/prescriptions.repository.js";
import { createDeliveryRepository } from "./repositories/delivery.repository.js";
import { createSellersRepository } from "./repositories/sellers.repository.js";
import { createSellerApplicationsRepository } from "./repositories/sellerApplications.repository.js";
import { createSellerPayoutsRepository } from "./repositories/sellerPayouts.repository.js";
import { createWishlistRepository } from "./repositories/wishlist.repository.js";
import { createRolesRepository } from "./repositories/roles.repository.js";
import { createSessionsRepository } from "./repositories/sessions.repository.js";
import { createUsersRepository } from "./repositories/users.repository.js";
import { createAuditService } from "./services/audit.service.js";
import { createAuthService } from "./services/auth.service.js";
import { createCatalogService } from "./services/catalog.service.js";
import { createNotificationsService } from "./services/notifications.service.js";
import { createNotificationsRepository } from "./repositories/notifications.repository.js";
import { createRetentionJob } from "./jobs/retention.js";
import { createScheduler } from "./jobs/scheduler.js";
import { createNotifier } from "./services/notifier.js";
import { createAddressesService } from "./services/addresses.service.js";
import { createPhoneTrust } from "./services/phoneTrust.js";
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
import { createStorageService } from "./services/storage.service.js";
import { createPaymentsService } from "./services/payments.service.js";
import { createPrescriptionsService } from "./services/prescriptions.service.js";
import { createSellersService } from "./services/sellers.service.js";
import { createSellerApplicationsService } from "./services/sellerApplications.service.js";
import { createRiderApplicationsService } from "./services/riderApplications.service.js";
import { createRiderProvisioning } from "./services/riderProvisioning.js";
import { createRiderApplicationsRepository } from "./repositories/riderApplications.repository.js";
import { createDeliveryService } from "./services/delivery.service.js";
import { createRealtime } from "./services/realtime.service.js";
import { createRoutingService } from "./services/routing.service.js";
import { createRiderAccess } from "./services/riderAccess.service.js";
import { createSellerPayoutsService } from "./services/sellerPayouts.service.js";
import { createCodProvider } from "./services/payments/cod.provider.js";
import { createManualProvider } from "./services/payments/manual.provider.js";
import { createDeliveryCodes } from "./utils/deliveryCode.js";
import { createEncryption } from "./utils/encryption.js";
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
    payments: createPaymentsRepository(),
    prescriptions: createPrescriptionsRepository(),
    sellers: createSellersRepository(),
    sellerApplications: createSellerApplicationsRepository(),
    riderApplications: createRiderApplicationsRepository(),
    sellerPayouts: createSellerPayoutsRepository(),
    delivery: createDeliveryRepository(),
    notifications: createNotificationsRepository(),
  };
  const tokens = createTokenService({ secret: config.auth.jwtSecret, ttlSeconds: config.auth.accessTtlSeconds });
  const notifier = createNotifier({ driver: config.notify.driver, logger, webhookUrl: config.notify.webhookUrl, webhookSecret: config.notify.webhookSecret, timeoutMs: config.notify.timeoutMs });
  const audit = createAuditService({ repo: repos.audit, pool });
  const phoneTrust = createPhoneTrust({ repos });

  // External (email/SMS) messages are only queued when a real channel exists — with "disabled" they would just retry and die.
  const notifications = createNotificationsService({ pool, repo: repos.notifications, notifier, logger, externalEnabled: config.notify.driver !== "disabled" });
  const services = {
    audit,
    notifications,
    auth: createAuthService({ config, pool, withTx, repos, hasher: createPasswordHasher(), tokens, notifier, audit }),
    users: createUsersService({ pool, withTx, repos, audit }),
    catalog: createCatalogService({ pool, withTx, repos, audit }),
    search: createSearchService({ pool, repos }),
    addresses: createAddressesService({ pool, withTx, repos, config, notifier, audit, phoneTrust }),
    wishlist: createWishlistService({ pool, repos }),
  };
  const coupons = createCouponsService({ repos });
  const pricing = createPricingService({ repos, coupons });
  services.cart = createCartService({ pool, repos, pricing });
  services.inventory = createInventoryService({ pool, withTx, repos, audit });
  services.purchasing = createPurchasingService({ pool, withTx, repos, audit });

  const storage = createStorageService(config);
  services.products = createProductsService({ pool, withTx, repos, audit, storage });
  const paymentProviders = {
    cod: createCodProvider(),
    manual: createManualProvider({ webhookSecret: config.payments.manualWebhookSecret }),
  };
  services.payments = createPaymentsService({ pool, withTx, repos, providers: paymentProviders, audit, notifications });
  services.prescriptions = createPrescriptionsService({ pool, withTx, repos, storage, audit, notifications });
  // The handover code is derived from a subkey of DATA_ENCRYPTION_KEY, never stored (utils/deliveryCode.js).
  const deliveryCodes = createDeliveryCodes(config.security.dataEncryptionKey);
  // Realtime tracking (SSE over LISTEN/NOTIFY). Its listener connects lazily on the first stream, so tests/scripts that build a container open nothing.
  services.realtime = createRealtime({ config, logger });
  const routing = createRoutingService({ accessToken: config.maps.accessToken, logger });
  services.orders = createOrdersService({ pool, withTx, repos, phoneTrust, pricing, audit, prescriptions: services.prescriptions, payments: services.payments, codes: deliveryCodes, notifications, realtime: services.realtime });
  // The single rider-authorisation service: used by the /rider/* middleware AND by every delivery service call.
  services.riderAccess = createRiderAccess({ repos });
  const provisionRider = createRiderProvisioning({ repos, audit }); // one way to make a rider: admin-add and application-approval both use it
  services.delivery = createDeliveryService({ pool, withTx, repos, audit, payments: services.payments, codes: deliveryCodes, notifications, riderAccess: services.riderAccess, provisionRider, realtime: services.realtime, routing });

  const encryption = createEncryption(config.security.dataEncryptionKey);
  services.sellers = createSellersService({ pool, withTx, repos, encryption, audit });
  services.sellerApplications = createSellerApplicationsService({ pool, withTx, repos, storage, encryption, audit, notifications });
  services.riderApplications = createRiderApplicationsService({ pool, withTx, repos, storage, encryption, audit, provisionRider, notifications });
  services.sellerPayouts = createSellerPayoutsService({ pool, withTx, repos, audit, notifications });

  // Background jobs: started by server.js (not here, so tests and scripts that build a container don't spawn timers).
  const scheduler = createScheduler({
    logger,
    jobs: [
      { name: "outbox", everyMs: 10_000, run: () => notifications.processOutbox() },
      { name: "retention", everyMs: 6 * 60 * 60_000, runOnStart: true, run: () => createRetentionJob({ pool, logger }).run() },
    ],
  });

  return { config, logger, pool, withTx, repos, tokens, services, storage, paymentProviders, encryption, scheduler };
}
