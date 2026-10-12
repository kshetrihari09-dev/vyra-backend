import { AppError, conflict, forbidden, notFound, unavailable } from "../utils/errors.js";

const PERMISSION = "support:pharmacist";
const STALE_SENDING_SECONDS = 45;   // a 'sending' claim older than this is a crashed attempt and may be retried
const PREVIEW_CHARS = 140;
const HISTORY_DEFAULT = 50;
const SNAPSHOT_LIMIT = 100;

const can = (actor, permission) => !!actor?.permissions?.includes(permission);
const oneLine = (s, max = 80) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
const shortId = (id) => String(id).slice(0, 8);
const preview = (s) => { const t = oneLine(s, 400); return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS - 1)}…` : t; };

const TOPIC_LABELS = {
  pharmacist: "Question for a pharmacist", order: "Order support", payment: "Payment support", delivery: "Delivery support",
  product: "Product question", return: "Return or refund", contact: "General contact",
};

/**
 * Pharmacist support: ONE live-chat/message thread per customer, a shared pharmacist inbox, and honest delivery status.
 *
 * Rules this service enforces (and the tests pin):
 *  - A customer only ever reaches their own thread: customer methods never take a conversation id, they look it up by the caller's id.
 *  - Staff methods need `support:pharmacist` and only see the 'pharmacy' department.
 *  - A form message is reported as sent ONLY when the notifier (a real channel — not console/disabled) accepted it.
 *  - Nothing here simulates a pharmacist: every staff message is written by an authenticated pharmacist.
 *  - Notifications raised for staff/customers carry no message text (no health details in the outbox or a provider's logs).
 */
export function createSupportService({ pool, withTx, repos, notifier, notifications, realtime, audit, config, logger }) {
  const repo = repos.support;
  const externalEnabled = config.notify.driver !== "disabled";

  // ------------------------------------------------------------------ helpers
  /** Can an email for this department actually leave the building? Console logging and "disabled" are NOT delivery. */
  function emailCapability(department) {
    const to = department === "pharmacy" ? config.support.pharmacyEmail : config.support.generalEmail;
    return { to, configured: notifier.deliversExternally === true && !!to };
  }

  const normalizePhone = (raw) => {
    const digits = String(raw ?? "").trim().replace(/[\s().-]/g, "");
    return /^\+?[0-9]{7,15}$/.test(digits) ? digits : null;
  };

  /** Dedicated pharmacy line first; else the customer's selected store line (never a demo store's number in production); else nothing. */
  async function resolvePhone(branchId) {
    const line = config.support.pharmacyPhone;
    if (line) return { display: line.display, tel: line.tel, label: "Pharmacy line", source: "pharmacy" };
    if (branchId) {
      const b = await repo.branchContact(pool, branchId);
      const tel = b?.phone && !(config.isProd && b.is_demo) ? normalizePhone(b.phone) : null;
      if (tel) return { display: b.phone.trim(), tel, label: `${b.name} store line`, source: "branch" };
    }
    return null;
  }

  async function presence(actor) {
    const online = await repo.onlinePharmacists(pool);
    return { available: online.length > 0, pharmacists: actor ? online.map((p) => ({ name: p.full_name })) : [] };
  }

  const refsDto = (m, { orders = true, prescriptions = true } = {}) => ({
    order: m.order_id && orders ? { id: m.order_id, number: m.order_number } : null,
    product: m.product_id ? { id: m.product_id, name: m.product_name } : null,
    prescription: m.prescription_id && prescriptions ? { id: m.prescription_id, status: m.prescription_status } : null,
  });

  function messageDto(m, viewer, actor) {
    return {
      id: m.id, seq: Number(m.seq), sender: m.sender_role,
      // Customers see the pharmacist's name; staff see the customer's. Nobody sees their own name echoed back.
      senderName: viewer === "customer" ? (m.sender_role === "staff" ? m.sender_name : null) : m.sender_name,
      via: m.via, topic: m.topic, body: m.body, createdAt: m.created_at, clientMessageId: m.client_message_id,
      refs: viewer === "customer" ? refsDto(m) : refsDto(m, { orders: can(actor, "orders:read_all"), prescriptions: can(actor, "prescriptions:read_all") }),
      email: m.via === "form" ? { status: m.email_status } : null,
    };
  }

  const customerConversationDto = (c, unread) => ({
    id: c.id, status: c.status, assignedPharmacist: c.assigned_name ?? null, unread, lastMessageAt: c.last_message_at,
  });
  const staffConversationDto = (c, unread) => ({
    id: c.id, status: c.status, customerName: c.customer_name, assignedTo: c.assigned_to ? { id: c.assigned_to, name: c.assigned_name } : null,
    unread, lastMessageAt: c.last_message_at, createdAt: c.created_at, resolvedAt: c.resolved_at,
  });

  function requireStaff(actor) { if (!can(actor, PERMISSION)) throw forbidden(); }

  /** A customer can only attach their OWN order/prescription (anything else answers exactly like "doesn't exist"). */
  async function validateRefs(actor, { orderId, productId, prescriptionId }) {
    const out = {};
    if (orderId) {
      const o = await repo.orderOf(pool, orderId);
      if (!o || o.user_id !== actor.id) throw notFound("ORDER_NOT_FOUND", "Order not found");
      out.orderId = orderId;
    }
    if (prescriptionId) {
      const rx = await repo.prescriptionOf(pool, prescriptionId);
      if (!rx || rx.user_id !== actor.id) throw notFound("PRESCRIPTION_NOT_FOUND", "Prescription not found");
      out.prescriptionId = prescriptionId;
    }
    if (productId) {
      if (!(await repo.productOf(pool, productId))) throw notFound("PRODUCT_NOT_FOUND", "Product not found");
      out.productId = productId;
    }
    return out;
  }

  /**
   * Gets a new customer message to a human. In-app notification to the assigned pharmacist (or all of them), and — when
   * nobody is online — a content-free heads-up to the pharmacy mailbox through the outbox so it isn't left unseen.
   */
  async function notifyPharmacy(db, conversation) {
    const recipients = conversation.assigned_to ? [conversation.assigned_to] : await repo.pharmacistIds(db);
    for (const userId of recipients) await notifications.emit(db, { userId, type: "support.new_message", data: { conversationId: conversation.id } });
    const alertTo = config.support.pharmacyEmail;
    if (alertTo && externalEnabled && (await repo.onlinePharmacists(db)).length === 0) {
      await repos.notifications.enqueue(db, {
        userId: null, channel: "email", to: alertTo, type: "support.pharmacy_alert",
        subject: "A customer is waiting in the Vyra pharmacist inbox",
        body: `A customer sent a message and no pharmacist is online.\nOpen the pharmacist console to read and reply: ${config.appUrl}/pharmacy`,
      });
    }
  }

  // ----------------------------------------------------------------- customer
  return {
    emailCapability,

    /** Public contact card. Phone/email come from configuration or the branch record — never from code. */
    async contact(actor, { branchId } = {}) {
      const [phone, online] = await Promise.all([resolvePhone(branchId), presence(actor)]);
      let unread = 0;
      if (actor) {
        const conv = await repo.findByCustomer(pool, actor.id, "pharmacy");
        if (conv) unread = await repo.unread(pool, conv.id, "customer");
      }
      const pharmacy = emailCapability("pharmacy"); const general = emailCapability("general");
      return {
        phone,
        email: {
          // `address` is only for a mailto: fallback; `canSend` says whether the in-app form can really deliver.
          pharmacy: { canSend: pharmacy.configured, address: config.support.pharmacyEmail },
          general: { canSend: general.configured, address: config.support.generalEmail },
        },
        chat: { signedIn: !!actor, available: online.available, pharmacists: online.pharmacists },
        unread,
      };
    },

    /** The caller's own thread (latest page) or { conversation: null }. */
    async chat(actor, { limit = HISTORY_DEFAULT } = {}) {
      const [conv, online] = [await repo.getByCustomerWithNames(pool, actor.id, "pharmacy"), await presence(actor)];
      if (!conv) return { conversation: null, messages: [], hasMore: false, presence: online };
      const page = await repo.listMessages(pool, conv.id, { limit });
      return {
        conversation: customerConversationDto(conv, await repo.unread(pool, conv.id, "customer")),
        messages: page.rows.map((m) => messageDto(m, "customer", actor)), hasMore: page.hasMore, presence: online,
      };
    },

    async chatHistory(actor, { before, limit = HISTORY_DEFAULT }) {
      const conv = await repo.findByCustomer(pool, actor.id, "pharmacy");
      if (!conv) return { messages: [], hasMore: false };
      const page = await repo.listMessages(pool, conv.id, { beforeSeq: before, limit });
      return { messages: page.rows.map((m) => messageDto(m, "customer", actor)), hasMore: page.hasMore };
    },

    /** Live-chat message. Creates the thread on first use; a repeat of the same clientMessageId returns the original. */
    async sendChat(actor, { body, clientMessageId, ...refInput }) {
      const refs = await validateRefs(actor, refInput);
      const saved = await withTx(async (db) => {
        const conv = await repo.lockOrCreate(db, actor.id, "pharmacy");
        const staffUnreadBefore = await repo.unread(db, conv.id, "staff");
        const { row, duplicate } = await repo.insertMessage(db, { conversationId: conv.id, senderId: actor.id, senderRole: "customer", via: "chat", body, clientMessageId, ...refs });
        if (!duplicate) {
          await repo.touch(db, conv.id, { reopen: conv.status === "resolved" });
          await repo.markRead(db, conv.id, "customer", Number(row.seq));
          await realtime.publish(db, conv.id);
          // Notify on the first unread message (not every line of a conversation) and whenever a resolved thread comes back.
          if (staffUnreadBefore === 0 || conv.status === "resolved") await notifyPharmacy(db, conv);
        }
        return { row, duplicate };
      });
      return { message: messageDto(saved.row, "customer", actor), duplicate: saved.duplicate, presence: await presence(actor) };
    },

    async markChatRead(actor) {
      const conv = await repo.findByCustomer(pool, actor.id, "pharmacy");
      if (conv) await repo.markRead(pool, conv.id, "customer", await repo.maxSeq(pool, conv.id));
      return { unread: 0 };
    },

    /**
     * The "message a pharmacist / contact support" form. Persisted first (so it is never lost and shows in the pharmacist
     * inbox), then emailed through the configured notifier. Returns success ONLY when the gateway accepted the email.
     * Safe to call again with the same clientRequestId after a failure: it retries the email, never duplicates the message.
     */
    async submitForm(actor, { topic, body, clientRequestId, ...refInput }) {
      const department = topic === "pharmacist" ? "pharmacy" : "general";
      const cap = emailCapability(department);
      // Refuse BEFORE storing anything: promising an email we cannot send would be the original bug in a new shape.
      if (!cap.configured) {
        throw unavailable("EMAIL_NOT_CONFIGURED", department === "pharmacy"
          ? "Emailing a pharmacist isn't available right now. Please use live chat or call the pharmacy."
          : "Emailing support isn't available right now. Please call us instead.");
      }
      const refs = await validateRefs(actor, refInput);

      const saved = await withTx(async (db) => {
        const conv = await repo.lockOrCreate(db, actor.id, department);
        const staffUnreadBefore = department === "pharmacy" ? await repo.unread(db, conv.id, "staff") : 0;
        const { row, duplicate } = await repo.insertMessage(db, { conversationId: conv.id, senderId: actor.id, senderRole: "customer", via: "form", topic, body, clientMessageId: clientRequestId, ...refs });
        if (!duplicate) {
          await repo.touch(db, conv.id, { reopen: conv.status === "resolved" });
          await repo.markRead(db, conv.id, "customer", Number(row.seq));
          if (department === "pharmacy") {
            await realtime.publish(db, conv.id);
            if (staffUnreadBefore === 0 || conv.status === "resolved") await notifyPharmacy(db, conv);
          }
        }
        return { row };
      });

      const accepted = (row) => ({ status: "accepted", message: messageDto(row, "customer", actor) });
      if (saved.row.email_status === "accepted") return accepted(saved.row);         // a retry of something already delivered

      // The slow network call happens OUTSIDE the transaction. The claim makes sure two parallel requests can't both send.
      if (!(await repo.claimEmailAttempt(pool, saved.row.id, { staleSeconds: STALE_SENDING_SECONDS }))) {
        const current = await repo.getMessage(pool, saved.row.id);
        if (current.email_status === "accepted") return accepted(current);
        throw conflict("SUBMISSION_IN_PROGRESS", "Your message is already being sent. Please wait a moment.");
      }
      const order = refs.orderId ? await repo.orderOf(pool, refs.orderId) : null;
      const product = refs.productId ? await repo.productOf(pool, refs.productId) : null;
      const lines = [
        `New message from a Vyra customer`,
        `Customer: ${oneLine(actor.name)}`,
        `Account email: ${actor.email || "(none on file)"}`,
        `Topic: ${TOPIC_LABELS[topic]}`,
        order && `Order: ${order.number}`,
        product && `Medicine/product: ${oneLine(product.name)}`,
        refs.prescriptionId && `Prescription ref: ${shortId(refs.prescriptionId)}`,
        `Message ref: ${shortId(saved.row.id)}`,
        "", "Message:", body, "",
        department === "pharmacy" ? `Reply in the pharmacist inbox: ${config.appUrl}/pharmacy` : "Reply to the customer by email (Reply-To is their account email).",
      ].filter((l) => l !== null && l !== false && l !== undefined);
      try {
        await notifier.sendEmail({ to: cap.to, subject: `[Vyra ${department}] ${TOPIC_LABELS[topic]} — ${oneLine(actor.name, 40)}`, text: lines.join("\n"), replyTo: actor.email || undefined });
      } catch (err) {
        await repo.markEmailFailed(pool, saved.row.id, err?.message ?? err);
        logger?.warn?.("support email was not accepted", { messageId: saved.row.id, error: String(err?.message ?? err).slice(0, 200) });
        throw new AppError(502, "EMAIL_DELIVERY_FAILED", "We couldn't send your message by email just now. Please try again.", { retryable: true });
      }
      await repo.markEmailAccepted(pool, saved.row.id);
      return accepted(await repo.getMessage(pool, saved.row.id));
    },

    /** Snapshot for the caller's own live stream: messages after the cursor + current presence. */
    async chatSnapshot(actor, afterSeq = 0) {
      const [conv, online] = [await repo.getByCustomerWithNames(pool, actor.id, "pharmacy"), await presence(actor)];
      if (!conv) return { conversation: null, messages: [], cursor: afterSeq, presence: online };
      const page = await repo.listMessages(pool, conv.id, { afterSeq: afterSeq || undefined, limit: SNAPSHOT_LIMIT });
      const messages = page.rows.map((m) => messageDto(m, "customer", actor));
      return {
        conversation: customerConversationDto(conv, await repo.unread(pool, conv.id, "customer")),
        messages, cursor: messages.reduce((n, m) => Math.max(n, m.seq), afterSeq), presence: online,
      };
    },

    // ----------------------------------------------------------- pharmacist side
    async inbox(actor, { status, page, pageSize }) {
      requireStaff(actor);
      const { rows, total } = await repo.inbox(pool, { status, limit: pageSize, offset: (page - 1) * pageSize });
      return {
        conversations: rows.map((c) => ({ ...staffConversationDto(c, Number(c.unread)), lastMessage: { preview: preview(c.last_body), sender: c.last_sender } })),
        page, pageSize, total, unreadConversations: await repo.unreadConversations(pool),
      };
    },

    async inboxConversation(actor, id) {
      requireStaff(actor);
      const c = await repo.getById(pool, id);
      if (!c || c.department !== "pharmacy") throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      return { conversation: staffConversationDto(c, await repo.unread(pool, id, "staff")) };
    },

    async inboxMessages(actor, id, { before, limit = HISTORY_DEFAULT }) {
      requireStaff(actor);
      const c = await repo.getById(pool, id);
      if (!c || c.department !== "pharmacy") throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      const page = await repo.listMessages(pool, id, { beforeSeq: before, limit });
      return { messages: page.rows.map((m) => messageDto(m, "staff", actor)), hasMore: page.hasMore };
    },

    /** A real, signed-in pharmacist's reply. The first one claims the conversation. */
    async reply(actor, id, { body, clientMessageId }) {
      requireStaff(actor);
      const saved = await withTx(async (db) => {
        const c = await repo.getById(db, id, { lock: true });
        if (!c || c.department !== "pharmacy") throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
        const customerUnreadBefore = await repo.unread(db, id, "customer");
        const { row, duplicate } = await repo.insertMessage(db, { conversationId: id, senderId: actor.id, senderRole: "staff", via: "chat", body, clientMessageId });
        if (!duplicate) {
          await repo.assignIfUnassigned(db, id, actor.id);
          await repo.touch(db, id, { reopen: c.status === "resolved" });
          await repo.markRead(db, id, "staff", Number(row.seq));      // answering means they have read everything before it
          await realtime.publish(db, id);
          if (customerUnreadBefore === 0) await notifications.emit(db, { userId: c.customer_id, type: "support.reply", data: { conversationId: id } });
        }
        return { row, duplicate };
      });
      return { message: messageDto(saved.row, "staff", actor), duplicate: saved.duplicate };
    },

    async markInboxRead(actor, id) {
      requireStaff(actor);
      const c = await repo.getById(pool, id);
      if (!c || c.department !== "pharmacy") throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      await repo.markRead(pool, id, "staff", await repo.maxSeq(pool, id));
      return { unreadConversations: await repo.unreadConversations(pool) };
    },

    async setStatus(actor, id, status, ctx) {
      requireStaff(actor);
      return withTx(async (db) => {
        const c = await repo.getById(db, id, { lock: true });
        if (!c || c.department !== "pharmacy") throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
        if (c.status === status) return { conversation: staffConversationDto(c, await repo.unread(db, id, "staff")) };
        await repo.setStatus(db, id, status, actor.id);
        await audit.log({ actor, action: `support.conversation.${status === "resolved" ? "resolved" : "reopened"}`, entityType: "support_conversation", entityId: id, oldValue: { status: c.status }, newValue: { status } }, ctx, db);
        await realtime.publish(db, id);
        const fresh = await repo.getById(db, id);
        return { conversation: staffConversationDto(fresh, await repo.unread(db, id, "staff")) };
      });
    },

    async staffSnapshot(actor, id, afterSeq = 0) {
      requireStaff(actor);
      const c = await repo.getById(pool, id);
      if (!c || c.department !== "pharmacy") throw notFound("CONVERSATION_NOT_FOUND", "Conversation not found");
      const page = await repo.listMessages(pool, id, { afterSeq: afterSeq || undefined, limit: SNAPSHOT_LIMIT });
      const messages = page.rows.map((m) => messageDto(m, "staff", actor));
      return { conversation: staffConversationDto(c, await repo.unread(pool, id, "staff")), messages, cursor: messages.reduce((n, m) => Math.max(n, m.seq), afterSeq) };
    },

    // ------------------------------------------------------------- availability
    /** Heartbeat-based: the console re-sends `available: true` every minute; stop sending and the pharmacist drops offline by themselves. */
    async setAvailability(actor, available) {
      requireStaff(actor);
      if (!available) { await repo.clearPresence(pool, actor.id); return { available: false, until: null }; }
      return { available: true, until: await repo.setPresence(pool, actor.id, config.support.presenceTtlSeconds) };
    },
    async getAvailability(actor) {
      requireStaff(actor);
      const p = await repo.getPresence(pool, actor.id);
      return { available: !!p?.online, until: p?.online ? p.available_until : null, heartbeatSeconds: Math.max(15, Math.floor(config.support.presenceTtlSeconds / 3)) };
    },
  };
}
