/** Demo suppliers and one already-received purchase order, matching data/suppliers.js. */
const SUPPLIERS = [
  { id: "sup-1", name: "MedSource Distributors", contact: "Anita Rao", phone: "+1 555 0410", email: "orders@medsource.example", terms: "Net 30" },
  { id: "sup-2", name: "Cipla Wholesale", contact: "Ravi Iyer", phone: "+1 555 0455", email: "wholesale@cipla-supply.example", terms: "Net 15" },
  { id: "sup-3", name: "GSK Regional Supply", contact: "Helen Cho", phone: "+1 555 0488", email: "supply@gsk-regional.example", terms: "Net 30" },
  { id: "sup-4", name: "Himalaya Direct", contact: "Sanjay Mehta", phone: "+1 555 0499", email: "b2b@himalaya-direct.example", terms: "Prepaid" },
];

export async function seedDemoPurchasing(db, { log = console.log } = {}) {
  for (const s of SUPPLIERS) {
    await db.query("INSERT INTO suppliers (id, name, contact, phone, email, terms, is_demo) VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT DO NOTHING",
      [s.id, s.name, s.contact, s.phone, s.email, s.terms]);
  }
  log(`demo suppliers: ${SUPPLIERS.length}`);
  return { suppliers: SUPPLIERS.length };
}
