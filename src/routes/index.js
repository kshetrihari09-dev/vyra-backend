import { Router } from "express";
import { createAuthController } from "../controllers/auth.controller.js";
import { createCatalogController } from "../controllers/catalog.controller.js";
import { createCommerceController } from "../controllers/commerce.controller.js";
import { createInventoryController } from "../controllers/inventory.controller.js";
import { createUsersController } from "../controllers/users.controller.js";
import { adminRoutes } from "./admin.routes.js";
import { authRoutes } from "./auth.routes.js";
import { catalogRoutes } from "./catalog.routes.js";
import { commerceRoutes } from "./commerce.routes.js";
import { inventoryRoutes } from "./inventory.routes.js";
import { healthRoutes } from "./health.routes.js";

/** Mounts every module under /api. Later phases add products, cart, orders, inventory, ... here. */
export function createRoutes(container, limiters) {
  const r = Router();
  r.use("/health", healthRoutes(container));
  r.use("/auth", authRoutes({ container, controller: createAuthController(container), limiters }));
  r.use("/", catalogRoutes({ container, controller: createCatalogController(container) }));
  r.use("/", commerceRoutes({ container, controller: createCommerceController(container) }));
  r.use("/", inventoryRoutes({ container, controller: createInventoryController(container) }));
  r.use("/admin", adminRoutes({ container, usersController: createUsersController(container) }));
  return r;
}
