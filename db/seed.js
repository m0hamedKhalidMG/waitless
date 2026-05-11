'use strict';
const db = require('./connection');
const bcrypt = require('bcrypt');

function seed() {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  if (existing.cnt > 0) {
    console.log('Database already seeded.');
    return;
  }

  console.log('Seeding database...');

  // --- Specialties ---
  const insertSpecialty = db.prepare('INSERT OR IGNORE INTO specialties(name) VALUES(?)');
  const specialties = ['طب عام', 'طب الأسنان', 'طب العيون', 'طب الأطفال', 'الجلدية والتجميل', 'أمراض القلب', 'العظام والمفاصل'];
  specialties.forEach(s => insertSpecialty.run(s));

  // --- Admin user ---
  const adminHash = bcrypt.hashSync('Admin@12345', 12);
  db.prepare(`INSERT INTO users(name, email, password_hash, phone, role) VALUES(?,?,?,?,?)`)
    .run('مدير النظام', 'admin@waitless.com', adminHash, '0500000000', 'admin');

  // --- Doctors (users + doctor profiles) ---
  const doctorPassword = bcrypt.hashSync('Doctor@123', 12);

  const doctorsData = [
    { name: 'د. أحمد العمري',     email: 'ahmed@waitless.com',   phone: '0511111111', specialty: 'طب عام',              avg: 15 },
    { name: 'د. سارة الزهراني',   email: 'sara@waitless.com',    phone: '0522222222', specialty: 'طب الأسنان',          avg: 20 },
    { name: 'د. خالد الشمري',     email: 'khaled@waitless.com',  phone: '0533333333', specialty: 'طب العيون',            avg: 15 },
    { name: 'د. منى الحربي',      email: 'mona@waitless.com',    phone: '0544444444', specialty: 'طب الأطفال',           avg: 15 },
    { name: 'د. فيصل الدوسري',    email: 'faisal@waitless.com',  phone: '0555555555', specialty: 'أمراض القلب',         avg: 25 },
  ];

  const insertUser   = db.prepare('INSERT INTO users(name, email, password_hash, phone, role) VALUES(?,?,?,?,?)');
  const insertDoctor = db.prepare('INSERT INTO doctors(user_id, specialty_id, avg_consultation_minutes) VALUES(?,?,?)');
  const insertSched  = db.prepare('INSERT INTO doctor_schedules(doctor_id, day_of_week, start_time, end_time, slot_duration_minutes) VALUES(?,?,?,?,?)');
  const getSpecialty = db.prepare('SELECT id FROM specialties WHERE name = ?');

  const seedAll = db.transaction(() => {
    for (const d of doctorsData) {
      const { lastInsertRowid: userId } = insertUser.run(d.name, d.email, doctorPassword, d.phone, 'doctor');
      const spec = getSpecialty.get(d.specialty);
      const { lastInsertRowid: docId } = insertDoctor.run(userId, spec.id, d.avg);

      // Working days: all week (0=Sun ... 6=Sat)
      for (let day = 0; day <= 6; day++) {
        insertSched.run(docId, day, '08:00', '16:00', d.avg);
      }
    }
  });

  seedAll();

  // --- Sample patients ---
  const patientPassword = bcrypt.hashSync('Patient@123', 12);
  const insertPatient = db.prepare('INSERT INTO users(name, email, password_hash, phone, role) VALUES(?,?,?,?,?)');
  const patients = [
    { name: 'محمد الغامدي',   email: 'mohammed@example.com', phone: '0566666666' },
    { name: 'نورة القحطاني',  email: 'noura@example.com',    phone: '0577777777' },
    { name: 'عبدالله السبيعي', email: 'abdullah@example.com', phone: '0588888888' },
  ];
  patients.forEach(p => insertPatient.run(p.name, p.email, patientPassword, p.phone, 'patient'));

  console.log('Seeding complete.');
  console.log('Admin login: admin@waitless.com / Admin@12345');
  console.log('Doctor login example: ahmed@waitless.com / Doctor@123');
  console.log('Patient login example: mohammed@example.com / Patient@123');
}

module.exports = { seed };
