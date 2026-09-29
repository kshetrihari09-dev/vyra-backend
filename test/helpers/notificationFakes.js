/** In-memory notifications repository with the same semantics as the SQL one (user scoping, opt-outs, outbox leasing). */
export function createFakeNotifications({ users = {} } = {}) {
  const db = { inbox: [], outbox: [], seq: 0, users };
  const now = () => new Date();
  const repo = {
    async insert(_d, n) { const row = { id: `n-${++db.seq}`, user_id: n.userId, type: n.type, kind: n.kind, title: n.title, message: n.message, data: n.data, read_at: null, created_at: new Date(Date.now() + db.seq) }; db.inbox.push(row); return row; },
    async list(_d, userId, { unreadOnly, limit }) { return db.inbox.filter((r) => r.user_id === userId && (!unreadOnly || !r.read_at)).sort((a, b) => b.created_at - a.created_at).slice(0, limit); },
    async unreadCount(_d, userId) { return db.inbox.filter((r) => r.user_id === userId && !r.read_at).length; },
    async markRead(_d, userId, id) { const r = db.inbox.find((x) => x.id === id && x.user_id === userId); if (!r) return false; r.read_at ??= now(); return true; },
    async markAllRead(_d, userId) { let n = 0; for (const r of db.inbox) if (r.user_id === userId && !r.read_at) { r.read_at = now(); n++; } return n; },
    async getContact(_d, userId) { return db.users[userId] ?? null; },
    async setPreferences(_d, userId, { email, sms }) { const u = db.users[userId]; if (email !== undefined) u.notify_email = email; if (sms !== undefined) u.notify_sms = sms; return u; },
    async enqueue(_d, m) { db.outbox.push({ id: ++db.seq, user_id: m.userId, channel: m.channel, to_address: m.to, subject: m.subject, body: m.body, type: m.type, status: "pending", attempts: 0, next_attempt_at: now(), locked_until: null, last_error: null }); },
    async claimDue(_d, { limit, leaseSeconds }) {
      const t = now();
      const due = db.outbox.filter((o) => (o.status === "pending" && o.next_attempt_at <= t) || (o.status === "sending" && o.locked_until < t)).slice(0, limit);
      for (const o of due) { o.status = "sending"; o.attempts++; o.locked_until = new Date(t.getTime() + leaseSeconds * 1000); }
      return due.map((o) => ({ ...o }));
    },
    async markSent(_d, id) { Object.assign(db.outbox.find((o) => o.id === id), { status: "sent", locked_until: null }); },
    async markRetry(_d, id, { delaySeconds, error }) { Object.assign(db.outbox.find((o) => o.id === id), { status: "pending", next_attempt_at: new Date(Date.now() + delaySeconds * 1000), locked_until: null, last_error: error }); },
    async markDead(_d, id, { error }) { Object.assign(db.outbox.find((o) => o.id === id), { status: "dead", locked_until: null, last_error: error }); },
    async outboxStats() { const s = {}; for (const o of db.outbox) s[o.status] = (s[o.status] ?? 0) + 1; return s; },
  };
  return { db, repo };
}

/** Drop-in for the `notifications` dependency that just records what was emitted. */
export function recordingNotifications() {
  const emitted = [];
  return { emitted, emit: async (_db, e) => { emitted.push(e); return null; } };
}
