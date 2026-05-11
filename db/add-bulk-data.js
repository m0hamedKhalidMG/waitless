'use strict';
const db = require('./connection');
const bcrypt = require('bcrypt');

console.log('=== Adding more data to Wait Less database ===\n');

// ── helpers ───────────────────────────────────────────────────────
function addMins(time, mins) {
  const [h, m] = time.split(':').map(Number);
  const t = h * 60 + m + mins;
  return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

// All working days (Sun-Thu) from Apr 14 to Jun 5 2026
function getWorkingDates(from, count) {
  const dates = [];
  const d = new Date(from);
  while (dates.length < count) {
    const dow = d.getDay();
    if (dow >= 0 && dow <= 4) dates.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

const DATES = getWorkingDates('2026-04-14', 30); // 30 working days

// ── New doctors ───────────────────────────────────────────────────
const doctorPwd = bcrypt.hashSync('Doctor@123', 10);
const newDoctors = [
  { name: 'د. ريم الشهراني',   email: 'reem@waitless.com',    phone: '0560000001', specialty: 'الجلدية والتجميل',  avg: 20 },
  { name: 'د. طارق المطيري',   email: 'tariq@waitless.com',   phone: '0560000002', specialty: 'العظام والمفاصل',   avg: 20 },
  { name: 'د. هنوف العتيبي',   email: 'hanouf@waitless.com',  phone: '0560000003', specialty: 'طب عام',            avg: 15 },
  { name: 'د. محمد القرشي',    email: 'mqarshi@waitless.com', phone: '0560000004', specialty: 'أمراض القلب',      avg: 25 },
];

// ── New patients ──────────────────────────────────────────────────
const patientPwd = bcrypt.hashSync('Patient@123', 10);
const newPatients = [
  { name: 'سلمى الرشيدي',    email: 'salma@example.com',   phone: '0570000001' },
  { name: 'فهد البقمي',      email: 'fahad@example.com',   phone: '0570000002' },
  { name: 'منيرة الجهني',    email: 'munira@example.com',  phone: '0570000003' },
  { name: 'ياسر الحازمي',    email: 'yasser@example.com',  phone: '0570000004' },
  { name: 'دلال المالكي',    email: 'dalal@example.com',   phone: '0570000005' },
  { name: 'عمر الشريف',      email: 'omar@example.com',    phone: '0570000006' },
];

const insertUser   = db.prepare('INSERT OR IGNORE INTO users(name,email,password_hash,phone,role) VALUES(?,?,?,?,?)');
const insertDoctor = db.prepare('INSERT OR IGNORE INTO doctors(user_id,specialty_id,avg_consultation_minutes) VALUES(?,?,?)');
const insertSched  = db.prepare('INSERT OR REPLACE INTO doctor_schedules(doctor_id,day_of_week,start_time,end_time,slot_duration_minutes) VALUES(?,?,?,?,?)');
const getSpecialty = db.prepare('SELECT id FROM specialties WHERE name=?');
const getUser      = db.prepare('SELECT id FROM users WHERE email=?');
const getDoctor    = db.prepare('SELECT id,avg_consultation_minutes FROM doctors WHERE user_id=?');

const addEverything = db.transaction(() => {

  // --- Add new doctors ---
  for (const d of newDoctors) {
    insertUser.run(d.name, d.email, doctorPwd, d.phone, 'doctor');
    const userId = getUser.get(d.email).id;
    const specId = getSpecialty.get(d.specialty)?.id;
    if (!specId) { console.log('Specialty not found:', d.specialty); continue; }
    insertDoctor.run(userId, specId, d.avg);
    const docId = getDoctor.get(userId).id;
    for (let day = 0; day <= 4; day++) {
      insertSched.run(docId, day, '08:00', '17:00', d.avg);
    }
    console.log(`✓ Doctor: ${d.name} (${d.email}) / Doctor@123`);
  }

  // --- Add new patients ---
  for (const p of newPatients) {
    insertUser.run(p.name, p.email, patientPwd, p.phone, 'patient');
    console.log(`✓ Patient: ${p.name} (${p.email}) / Patient@123`);
  }
});

addEverything();

// ── Now load ALL doctors & patients ──────────────────────────────
const allDoctors = db.prepare(`
  SELECT d.id, d.avg_consultation_minutes AS avg, u.name, u.email, s.name AS spec
  FROM doctors d
  JOIN users u ON u.id=d.user_id
  JOIN specialties s ON s.id=d.specialty_id
  WHERE d.is_active=1 ORDER BY d.id
`).all();

const allPatients = db.prepare(`
  SELECT id, name, email FROM users WHERE role='patient' ORDER BY id
`).all();

console.log(`\nTotal doctors: ${allDoctors.length}  |  Total patients: ${allPatients.length}`);

// ── Build lots of appointments ────────────────────────────────────
const insertAppt = db.prepare(`
  INSERT OR IGNORE INTO appointments
    (patient_id,doctor_id,appointment_date,appointment_time,end_time,status,notes)
  VALUES (?,?,?,?,?,?,?)
`);

const notesBySpec = {
  'طب عام':             ['كشف عام', 'متابعة ضغط الدم', 'كشف دوري', 'متابعة سكر الدم', 'شهادة طبية', 'متابعة الدواء', ''],
  'طب الأسنان':         ['تنظيف أسنان', 'حشو ضرس', 'استشارة تقويم', 'خلع ضرس العقل', 'تلبيس تاج', ''],
  'طب العيون':          ['فحص نظر', 'متابعة ضعف النظر', 'قياس ضغط العين', 'استشارة نظارات', ''],
  'طب الأطفال':         ['متابعة النمو', 'لقاحات دورية', 'كشف دوري', 'حمى وبرد', ''],
  'الجلدية والتجميل':  ['علاج حب الشباب', 'فحص الجلد', 'علاج إكزيما', 'بقع جلدية', ''],
  'أمراض القلب':        ['رسم قلب', 'فحص دوري للقلب', 'متابعة الدواء', 'ضيق تنفس', ''],
  'العظام والمفاصل':   ['ألم ركبة', 'إصابة رياضية', 'التهاب مفاصل', 'فحص عمود الفقري', ''],
};

function pick(arr, i) { return arr[i % arr.length]; }

let totalInserted = 0;
const addAppts = db.transaction(() => {
  for (const doc of allDoctors) {
    const notes = notesBySpec[doc.spec] || [''];
    let slotTime = '08:00';
    let dateIdx  = 0;
    let appts    = 0;
    const target = 6 + allDoctors.indexOf(doc); // 6-14 appointments per doctor

    while (appts < target && dateIdx < DATES.length) {
      // pick a patient (rotate)
      const pat = allPatients[(appts + allDoctors.indexOf(doc) * 3) % allPatients.length];
      const note = pick(notes, appts);
      const endTime = addMins(slotTime, doc.avg);
      const status  = appts < 2 ? 'confirmed' : 'scheduled';
      const date    = DATES[dateIdx];

      const r = insertAppt.run(pat.id, doc.id, date, slotTime, endTime, status, note || null);
      if (r.changes > 0) {
        appts++;
        totalInserted++;
      }

      // Move to next slot; after 4 slots on same day, move to next day
      slotTime = addMins(slotTime, doc.avg);
      if (slotTime >= '13:00') { slotTime = '08:00'; dateIdx++; }
    }
  }
});

addAppts();
console.log(`\n✅ Added ${totalInserted} more appointments across ${allDoctors.length} doctors.\n`);

// ── Print all credentials ─────────────────────────────────────────
const allUsers = db.prepare(`SELECT name,email,role FROM users ORDER BY role,id`).all();

console.log('════════════════════════════════════════════════════════');
console.log('              ALL USER CREDENTIALS                     ');
console.log('════════════════════════════════════════════════════════');
console.log('\n🔴 ADMIN:');
allUsers.filter(u => u.role === 'admin').forEach(u =>
  console.log(`   ${u.email.padEnd(32)} Password: Admin@12345   (${u.name})`)
);
console.log('\n🔵 DOCTORS (all share password: Doctor@123):');
allUsers.filter(u => u.role === 'doctor').forEach(u =>
  console.log(`   ${u.email.padEnd(32)} Password: Doctor@123    (${u.name})`)
);
console.log('\n🟢 PATIENTS (all share password: Patient@123):');
allUsers.filter(u => u.role === 'patient').forEach(u =>
  console.log(`   ${u.email.padEnd(32)} Password: Patient@123   (${u.name})`)
);
console.log('\n════════════════════════════════════════════════════════');
