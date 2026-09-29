import { Router } from "express";
import { createAuthController } from "../controllers/auth.controller.js";
import { createCatalogController } from "../controllers/catalog.controller.js";
import { createCommerceController } from "../controllers/commerce.controller.js";
import { createInventoryController } from "../controllers/inventory.controller.js";
import { createPaymentsController } from "../controllers/payments.controller.js";
import { createPrescriptionsController } from "../controllers/prescriptions.controller.js";
import { createSellersController } from "../controllers/sellers.controller.js";
import { createSellerApplicationsController } from "../controllers/sellerApplications.controller.js";
import { createSellerPayoutsController } from "../controllers/sellerPayouts.controller.js";
import { createDeliveryController } from "../controllers/delivery.controller.js";
import { createNotificationsController } from "../controllers/notifications.controller.js";
import { createUsersController } from "../controllers/users.controller.js";
import { adminRoutes } from "./admin.routes.js";
import { authRoutes } from "./auth.routes.js";
import { catalogRoutes } from "./catalog.routes.js";
import { commerceRoutes } from "./commerce.routes.js";
import { inventoryRoutes } from "./inventory.routes.js";
import { paymentsRoutes } from "./payments.routes.js";
import { prescriptionsRoutes } from "./prescriptions.routes.js";
import { sellersRoutes } from "./sellers.routes.js";
import { sellerApplicationsRoutes } from "./sellerApplications.routes.js";
import { sellerPayoutsRoutes } from "./sellerPayouts.routes.js";
import { deliveryRoutes } from "./delivery.routes.js";
import { notificationsRoutes } from "./notifications.routes.js";
import { healthRoutes } from "./health.routes.js";

/** Mounts every module under /api. Later phases add products, cart, orders, inventory, ... here. */
export function createRoutes(container, limiters) {
  const r = Router();
  r.use("/health", healthRoutes(container));
  r.use("/auth", authRoutes({ container, controller: createAuthController(container), limiters }));
  r.use("/", catalogRoutes({ container, controller: createCatalogController(container) }));
  r.use("/", commerceRoutes({ container, controller: createCommerceController(container) }));
  r.use("/", inventoryRoutes({ container, controller: createInventoryController(container) }));
  r.use("/", paymentsRoutes({ container, controller: createPaymentsController(container) }));
  r.use("/", prescriptionsRoutes({ container, controller: createPrescriptionsController(container) }));
  r.use("/", sellersRoutes({ container, controller: createSellersController(container) }));
  r.use("/", sellerApplicationsRoutes({ container, controller: createSellerApplicationsController(container) }));
  r.use("/", sellerPayoutsRoutes({ container, controller: createSellerPayoutsController(container) }));
  r.use("/", deliveryRoutes({ container, controller: createDeliveryController(container) }));
  r.use("/", notificationsRoutes({ container, controller: createNotificationsController(container) }));
  r.use("/admin", adminRoutes({ container, usersController: createUsersController(container) }));
  return r;
}
