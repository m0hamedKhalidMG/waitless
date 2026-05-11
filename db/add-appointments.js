'use strict';
const db = require('./connection');

// Get all doctors with their avg consultation time
const doctors = db.prepare(`
  SELECT d.id, u.name, d.avg_consultation_minutes, s.name AS specialty
  FROM doctors d
  JOIN users u ON u.id = d.user_id
  JOIN specialties s ON s.id = d.specialty_id
  WHERE d.is_active = 1
`).all();

// Get all patients
const patients = db.prepare(`
  SELECT id, name FROM users WHERE role = 'patient'
`).all();

console.log('Doctors:', doctors.map(d => `${d.name} (${d.specialty})`));
console.log('Patients:', patients.map(p => p.name));

if (doctors.length === 0 || patients.length === 0) {
  console.log('No doctors or patients found. Run the app first to seed.');
  process.exit(1);
}

// Helper: add minutes to a time string "HH:MM"
function addMinutes(time, mins) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + mins;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return String(nh).padStart(2, '0') + ':' + String(nm).padStart(2, '0');
}

// Generate dates starting tomorrow for the next 3 weeks (skip Fri/Sat)
function getFutureDates(count) {
  const dates = [];
  const d = new Date('2026-04-14'); // start from tomorrow (April 14)
  while (dates.length < count) {
    const dow = d.getDay(); // 0=Sun ... 6=Sat
    if (dow >= 0 && dow <= 4) { // Sun-Thu only
      dates.push(d.toISOString().split('T')[0]);
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

const futureDates = getFutureDates(15); // 15 working days
console.log('Future working dates:', futureDates);

const insertAppt = db.prepare(`
  INSERT OR IGNORE INTO appointments
    (patient_id, doctor_id, appointment_date, appointment_time, end_time, status, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Appointment data: each doctor gets several appointments on different days
const appointmentSlots = [
  // { doctorIdx, patientIdx, dateIdx, startTime, status, notes }
  // Doctor 0 (طب عام)
  { d: 0, p: 0, date: futureDates[0],  time: '08:00', status: 'confirmed',  notes: 'كشف عام - متابعة ضغط الدم' },
  { d: 0, p: 1, date: futureDates[0],  time: '08:15', status: 'scheduled',  notes: '' },
  { d: 0, p: 2, date: futureDates[0],  time: '08:30', status: 'scheduled',  notes: 'كشف دوري' },
  { d: 0, p: 0, date: futureDates[2],  time: '09:00', status: 'scheduled',  notes: '' },
  { d: 0, p: 1, date: futureDates[2],  time: '09:15', status: 'scheduled',  notes: '' },
  { d: 0, p: 2, date: futureDates[5],  time: '10:00', status: 'scheduled',  notes: 'متابعة نتائج التحاليل' },
  { d: 0, p: 0, date: futureDates[7],  time: '08:00', status: 'scheduled',  notes: '' },

  // Doctor 1 (طب الأسنان)
  { d: 1, p: 1, date: futureDates[0],  time: '08:00', status: 'confirmed',  notes: 'تنظيف أسنان' },
  { d: 1, p: 2, date: futureDates[0],  time: '08:20', status: 'scheduled',  notes: '' },
  { d: 1, p: 0, date: futureDates[1],  time: '09:00', status: 'scheduled',  notes: 'حشو ضرس' },
  { d: 1, p: 1, date: futureDates[3],  time: '10:00', status: 'scheduled',  notes: '' },
  { d: 1, p: 2, date: futureDates[6],  time: '08:00', status: 'scheduled',  notes: 'استشارة تقويم' },
  { d: 1, p: 0, date: futureDates[9],  time: '11:00', status: 'scheduled',  notes: '' },

  // Doctor 2 (طب العيون)
  { d: 2, p: 2, date: futureDates[1],  time: '08:00', status: 'confirmed',  notes: 'فحص نظر' },
  { d: 2, p: 0, date: futureDates[1],  time: '08:15', status: 'scheduled',  notes: '' },
  { d: 2, p: 1, date: futureDates[3],  time: '09:00', status: 'scheduled',  notes: 'متابعة ضعف النظر' },
  { d: 2, p: 2, date: futureDates[5],  time: '08:30', status: 'scheduled',  notes: '' },
  { d: 2, p: 0, date: futureDates[8],  time: '10:00', status: 'scheduled',  notes: '' },

  // Doctor 3 (طب الأطفال)
  { d: 3, p: 0, date: futureDates[2],  time: '08:00', status: 'confirmed',  notes: 'متابعة نمو الطفل' },
  { d: 3, p: 1, date: futureDates[2],  time: '08:15', status: 'scheduled',  notes: 'لقاحات دورية' },
  { d: 3, p: 2, date: futureDates[4],  time: '09:00', status: 'scheduled',  notes: '' },
  { d: 3, p: 0, date: futureDates[6],  time: '08:00', status: 'scheduled',  notes: '' },
  { d: 3, p: 1, date: futureDates[10], time: '10:00', status: 'scheduled',  notes: 'كشف دوري' },

  // Doctor 4 (أمراض القلب)
  { d: 4, p: 2, date: futureDates[0],  time: '08:00', status: 'confirmed',  notes: 'فحص القلب الدوري' },
  { d: 4, p: 0, date: futureDates[0],  time: '08:25', status: 'scheduled',  notes: '' },
  { d: 4, p: 1, date: futureDates[3],  time: '09:00', status: 'scheduled',  notes: 'رسم قلب' },
  { d: 4, p: 2, date: futureDates[5],  time: '10:00', status: 'scheduled',  notes: '' },
  { d: 4, p: 0, date: futureDates[8],  time: '08:00', status: 'scheduled',  notes: 'متابعة الدواء' },
  { d: 4, p: 1, date: futureDates[12], time: '11:00', status: 'scheduled',  notes: '' },
];

let inserted = 0;
const addAll = db.transaction(() => {
  for (const slot of appointmentSlots) {
    const doc = doctors[slot.d];
    const pat = patients[slot.p % patients.length];
    if (!doc || !pat) continue;

    const endTime = addMinutes(slot.time, doc.avg_consultation_minutes);
    const result = insertAppt.run(
      pat.id, doc.id, slot.date, slot.time, endTime, slot.status, slot.notes || null
    );
    if (result.changes > 0) {
      inserted++;
      console.log(`✓ [${slot.date}] ${doc.name} ← ${pat.name} ${slot.time}–${endTime} (${slot.status})`);
    }
  }
});

addAll();
console.log(`\n✅ Done! Added ${inserted} appointments.`);
