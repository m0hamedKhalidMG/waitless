const db = require('./connection');

(async () => {
  // Add default Friday (5) and Saturday (6) schedules for doctors who have Sun-Thu but not Fri-Sat
  const doctors = await db.prepare('SELECT id, avg_consultation_minutes FROM doctors WHERE is_active = 1').all();
  const insertSched = db.prepare(`
    INSERT OR IGNORE INTO doctor_schedules(doctor_id, day_of_week, start_time, end_time, slot_duration_minutes)
    VALUES(?, ?, ?, ?, ?)
  `);

  let added = 0;
  for (const doc of doctors) {
    for (const day of [5, 6]) {
      const existing = await db.prepare('SELECT id FROM doctor_schedules WHERE doctor_id = ? AND day_of_week = ?').get(doc.id, day);
      if (!existing) {
        await insertSched.run(doc.id, day, '08:00', '16:00', doc.avg_consultation_minutes);
        added++;
      }
    }
  }

  console.log(`Added ${added} missing weekend schedules.`);
})();
