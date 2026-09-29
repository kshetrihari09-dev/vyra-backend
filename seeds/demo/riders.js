/** Demo rider profiles for the demo `delivery` accounts (see users.js). Idempotent; every row is flagged is_demo. */
const RIDERS = [
  { email: "rider@vyra.example", phone: "+1 555 0231", vehicle: "Scooter · MC-4418", available: true },
  { email: "rider2@vyra.example", phone: "+1 555 0232", vehicle: "Bike · BK-2207", available: true },
];

export async function seedDemoRiders(db, { log = console.log } = {}) {
  let created = 0;
  for (const r of RIDERS) {
    const { rows } = await db.query(
      `INSERT INTO riders (user_id, phone, vehicle, is_available, is_demo)
       SELECT id, $2, $3, $4, true FROM users WHERE email = $1
       ON CONFLICT (user_id) DO NOTHING RETURNING id`,
      [r.email, r.phone, r.vehicle, r.available],
    );
    if (rows[0]) created++;
  }
  log(`demo riders: ${created} created`);
  return { created };
}
