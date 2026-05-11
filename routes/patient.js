'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getAvailableSlots, onCancellation } = require('../utils/scheduler');
const { countUnread, getNotifications, markAllRead, markRead } = require('../utils/notifications');
const { getQueuePosition, estimateWaitTime } = require('../utils/queue-predictor');
const { body, validationResult } = require('express-validator');

const guard = [requireAuth, requireRole('patient')];

// Local date helper (avoids UTC offset shifting the date)
function localDate() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Normalize any incoming date string to YYYY-MM-DD
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  // Handle DD/MM/YYYY or MM/DD/YYYY slash formats
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const p1 = parseInt(slashMatch[1], 10);
    const p2 = parseInt(slashMatch[2], 10);
    const year = parseInt(slashMatch[3], 10);
    // If p1 > 12 it must be DD/MM/YYYY, otherwise assume MM/DD/YYYY
    const month = p1 > 12 ? p2 : p1;
    const day   = p1 > 12 ? p1 : p2;
    return year + '-' +
      String(month).padStart(2, '0') + '-' +
      String(day).padStart(2, '0');
  }
  // Fallback: try native parsing
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Dashboard
router.get('/dashboard', guard, async (req, res) => {
  const userId = req.session.user.id;
  const today = localDate();

  const upcomingAppointments = await db.prepare(`
    SELECT a.*, u.name as doctor_name, s.name as specialty_name, d.id as doc_id
    FROM appointments a
    JOIN doctors d ON a.doctor_id = d.id
    JOIN users u ON d.user_id = u.id
    JOIN specialties s ON d.specialty_id = s.id
    WHERE a.patient_id = ? AND a.appointment_date >= ? AND a.status NOT IN ('cancelled','completed','no_show')
    ORDER BY a.appointment_date, a.appointment_time
    LIMIT 5
  `).all(userId, today);

  const queueInfo = await db.prepare(`
    SELECT q.position, q.status, q.doctor_id, u.name as doctor_name
    FROM queue_entries q
    JOIN doctors d ON q.doctor_id = d.id
    JOIN users u ON d.user_id = u.id
    WHERE q.patient_id = ? AND q.date = ? AND q.status IN ('waiting','called')
    LIMIT 1
  `).get(userId, today);

  const unreadCount = await countUnread(userId);
  const recentNotifs = await getNotifications(userId, 5, 0);

  res.render('patient/dashboard', {
    title: 'لوحة المريض',
    upcomingAppointments,
    queueInfo,
    unreadCount,
    recentNotifs,
    today
  });
});

// List appointments
router.get('/appointments', guard, async (req, res) => {
  const userId = req.session.user.id;
  const filter = req.query.filter || 'upcoming';
  const today = localDate();

  let whereClause = '';
  const filterParams = [userId];
  if (filter === 'upcoming') { whereClause = `AND a.appointment_date >= ? AND a.status NOT IN ('cancelled','completed','no_show')`; filterParams.push(today); }
  else if (filter === 'past') { whereClause = `AND (a.appointment_date < ? OR a.status IN ('completed','no_show'))`; filterParams.push(today); }
  else if (filter === 'cancelled') { whereClause = `AND a.status = 'cancelled'`; }

  const appointments = await db.prepare(`
    SELECT a.*, u.name as doctor_name, s.name as specialty_name
    FROM appointments a
    JOIN doctors d ON a.doctor_id = d.id
    JOIN users u ON d.user_id = u.id
    JOIN specialties s ON d.specialty_id = s.id
    WHERE a.patient_id = ? ${whereClause}
    ORDER BY a.appointment_date DESC, a.appointment_time DESC
  `).all(...filterParams);

  res.render('patient/appointments', { title: 'مواعيدي', appointments, filter });
});

// Cancel appointment
router.post('/appointments/:id/cancel', guard, async (req, res) => {
  const userId = req.session.user.id;
  const appt = await db.prepare('SELECT * FROM appointments WHERE id = ? AND patient_id = ?')
    .get(req.params.id, userId);

  if (!appt || !['scheduled', 'confirmed'].includes(appt.status)) {
    req.session.flash = { error: 'لا يمكن إلغاء هذا الموعد.' };
    return res.redirect('/patient/appointments');
  }

  await db.prepare(`UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(appt.id);
  await onCancellation(appt.id);

  req.session.flash = { success: 'تم إلغاء الموعد بنجاح.' };
  res.redirect('/patient/appointments');
});

// Book appointment — step 1: choose specialty
router.get('/book', guard, async (req, res) => {
  const specialties = await db.prepare(`
    SELECT s.*, COUNT(d.id) as doctor_count
    FROM specialties s
    LEFT JOIN doctors d ON d.specialty_id = s.id AND d.is_active = 1
    GROUP BY s.id
    HAVING doctor_count > 0
    ORDER BY s.name
  `).all();
  res.render('patient/book-step1', { title: 'حجز موعد - اختيار التخصص', specialties });
});

// Book — step 2: choose doctor
router.get('/book/doctors', guard, async (req, res) => {
  const specialtyId = parseInt(req.query.specialty_id);
  if (!specialtyId) return res.redirect('/patient/book');

  const specialty = await db.prepare('SELECT * FROM specialties WHERE id = ?').get(specialtyId);
  if (!specialty) return res.redirect('/patient/book');

  const doctors = await db.prepare(`
    SELECT d.id, d.avg_consultation_minutes, u.name, u.phone
    FROM doctors d
    JOIN users u ON d.user_id = u.id
    WHERE d.specialty_id = ? AND d.is_active = 1
    ORDER BY u.name
  `).all(specialtyId);

  res.render('patient/book-step2', { title: 'حجز موعد - اختيار الطبيب', doctors, specialty });
});

// Book — step 3: choose slot
router.get('/book/slots', guard, async (req, res) => {
  const doctorId = parseInt(req.query.doctor_id);
  if (!doctorId) return res.redirect('/patient/book');

  const doctor = await db.prepare(`
    SELECT d.id, d.avg_consultation_minutes, d.specialty_id, u.name, s.name as specialty_name
    FROM doctors d JOIN users u ON d.user_id = u.id JOIN specialties s ON d.specialty_id = s.id
    WHERE d.id = ? AND d.is_active = 1
  `).get(doctorId);
  if (!doctor) return res.redirect('/patient/book');

  const today = localDate();
  const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 180);
  const d = maxDate;
  const toDate = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

  const rawDate = req.query.date;
  const selectedDate = normalizeDate(rawDate);
  let slots = [];
  if (selectedDate && selectedDate >= today && selectedDate <= toDate) {
    slots = await getAvailableSlots(doctorId, selectedDate, selectedDate, 100);
  }

  // Fetch doctor working schedule days
  const schedules = await db.prepare('SELECT day_of_week, start_time, end_time FROM doctor_schedules WHERE doctor_id = ? ORDER BY day_of_week').all(doctorId);
  const dayNames = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const workingDays = schedules.map(s => dayNames[s.day_of_week]);

  res.render('patient/book-step3', { title: 'حجز موعد - اختيار الوقت', doctor, slots, today, toDate, selectedDate, workingDays, schedules });
});

// Book — step 4: confirm booking
router.post('/book/confirm', guard, [
  body('doctor_id').isInt(),
  body('date').isDate(),
  body('time').matches(/^\d{2}:\d{2}$/)
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.flash = { error: 'بيانات الحجز غير صحيحة.' };
    return res.redirect('/patient/book');
  }

  const userId = req.session.user.id;
  const { doctor_id, date, time, notes } = req.body;
  const docId = parseInt(doctor_id);

  const doctor = await db.prepare(`SELECT d.*, u.name as doctor_name FROM doctors d JOIN users u ON d.user_id = u.id WHERE d.id = ? AND d.is_active = 1`).get(docId);
  if (!doctor) {
    req.session.flash = { error: 'الطبيب غير موجود.' };
    return res.redirect('/patient/book');
  }

  // Verify slot is still free
  const conflict = await db.prepare(`
    SELECT id FROM appointments
    WHERE doctor_id = ? AND appointment_date = ? AND appointment_time = ? AND status NOT IN ('cancelled','no_show')
  `).get(docId, date, time);
  if (conflict) {
    req.session.flash = { error: 'هذا الموعد محجوز بالفعل. يرجى اختيار وقت آخر.' };
    return res.redirect(`/patient/book/slots?doctor_id=${docId}`);
  }

  // Check patient doesn't already have an appointment with this doctor on same day
  const sameDay = await db.prepare(`
    SELECT id FROM appointments
    WHERE patient_id = ? AND doctor_id = ? AND appointment_date = ? AND status NOT IN ('cancelled','no_show')
  `).get(userId, docId, date);
  if (sameDay) {
    req.session.flash = { error: 'لديك موعد بالفعل مع هذا الطبيب في نفس اليوم.' };
    return res.redirect(`/patient/book/slots?doctor_id=${docId}`);
  }

  const endMins = timeToMinutes(time) + doctor.avg_consultation_minutes;
  const endTime = minutesToTime(endMins);

  await db.prepare(`
    INSERT INTO appointments(patient_id, doctor_id, appointment_date, appointment_time, end_time, status, notes)
    VALUES(?, ?, ?, ?, ?, 'scheduled', ?)
  `).run(userId, docId, date, time, endTime, notes || null);

  req.session.flash = { success: `تم حجز موعدك يوم ${date} الساعة ${time} مع ${doctor.doctor_name}.` };
  res.redirect('/patient/appointments');
});

// Join waiting list
router.get('/waiting-list', guard, async (req, res) => {
  const userId = req.session.user.id;
  const specialties = await db.prepare(`
    SELECT s.* FROM specialties s
    JOIN doctors d ON d.specialty_id = s.id AND d.is_active = 1
    GROUP BY s.id
  `).all();

  // Attach doctors list to each specialty
  const allDoctors = await db.prepare(`
    SELECT d.id, u.name, d.specialty_id
    FROM doctors d
    JOIN users u ON d.user_id = u.id
    WHERE d.is_active = 1
    ORDER BY u.name
  `).all();
  specialties.forEach(s => {
    s.doctors = allDoctors.filter(d => d.specialty_id === s.id);
  });

  const myWaiting = await db.prepare(`
    SELECT wl.*, u.name as doctor_name, s.name as specialty_name
    FROM waiting_list wl
    JOIN doctors d ON wl.doctor_id = d.id
    JOIN users u ON d.user_id = u.id
    JOIN specialties s ON d.specialty_id = s.id
    WHERE wl.patient_id = ? AND wl.status IN ('waiting','notified')
    ORDER BY wl.created_at DESC
  `).all(userId);

  res.render('patient/waiting-list', { title: 'قائمة الانتظار', specialties, myWaiting, today: localDate() });
});

router.post('/waiting-list', guard, [
  body('doctor_id').isInt(),
  body('date_from').isDate(),
  body('date_to').isDate().custom((val, { req }) => {
    if (val < req.body.date_from) throw new Error('تاريخ النهاية يجب أن يكون بعد تاريخ البداية');
    return true;
  })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.flash = { error: 'يرجى إدخال البيانات بشكل صحيح.' };
    return res.redirect('/patient/waiting-list');
  }

  const userId = req.session.user.id;
  const { doctor_id, date_from, date_to } = req.body;

  const existing = await db.prepare(`
    SELECT id FROM waiting_list WHERE patient_id = ? AND doctor_id = ? AND status IN ('waiting','notified')
  `).get(userId, parseInt(doctor_id));

  if (existing) {
    req.session.flash = { error: 'أنت بالفعل في قائمة الانتظار لهذا الطبيب.' };
    return res.redirect('/patient/waiting-list');
  }

  await db.prepare(`
    INSERT INTO waiting_list(patient_id, doctor_id, preferred_date_from, preferred_date_to)
    VALUES(?, ?, ?, ?)
  `).run(userId, parseInt(doctor_id), date_from, date_to);

  req.session.flash = { success: 'تم إضافتك لقائمة الانتظار. سنرسل لك إشعاراً عند توفر موعد.' };
  res.redirect('/patient/waiting-list');
});

// Cancel waiting list entry
router.post('/waiting-list/:id/cancel', guard, async (req, res) => {
  const userId = req.session.user.id;
  await db.prepare(`UPDATE waiting_list SET status = 'cancelled' WHERE id = ? AND patient_id = ?`)
    .run(req.params.id, userId);
  req.session.flash = { success: 'تم إلغاء طلب الانتظار.' };
  res.redirect('/patient/waiting-list');
});

// Confirm waiting list offer
router.post('/waiting-list/:id/confirm', guard, async (req, res) => {
  const userId = req.session.user.id;
  const entry = await db.prepare(`
    SELECT * FROM waiting_list WHERE id = ? AND patient_id = ? AND status = 'notified'
  `).get(req.params.id, userId);

  if (!entry) {
    req.session.flash = { error: 'العرض غير موجود أو انتهت صلاحيته.' };
    return res.redirect('/patient/notifications');
  }

  // Check not expired
  if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
    req.session.flash = { error: 'انتهت صلاحية هذا العرض.' };
    return res.redirect('/patient/notifications');
  }

  await db.prepare(`UPDATE waiting_list SET status = 'confirmed' WHERE id = ?`).run(entry.id);
  await db.prepare(`UPDATE appointments SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`)
    .run(entry.offered_appointment_id);

  req.session.flash = { success: 'تم تأكيد الموعد بنجاح!' };
  res.redirect('/patient/appointments');
});

// Decline waiting list offer
router.post('/waiting-list/:id/decline', guard, async (req, res) => {
  const userId = req.session.user.id;
  const entry = await db.prepare(`SELECT * FROM waiting_list WHERE id = ? AND patient_id = ?`).get(req.params.id, userId);
  if (entry && entry.offered_appointment_id) {
    await db.prepare(`UPDATE waiting_list SET status = 'cancelled' WHERE id = ?`).run(entry.id);
    // Trigger re-offer to next person
    await onCancellation(entry.offered_appointment_id);
  }
  req.session.flash = { success: 'تم رفض العرض.' };
  res.redirect('/patient/notifications');
});

// Queue status
router.get('/queue', guard, async (req, res) => {
  const userId = req.session.user.id;
  const today = localDate();

  const queueEntry = await db.prepare(`
    SELECT q.*, d.avg_consultation_minutes, u.name as doctor_name, s.name as specialty_name
    FROM queue_entries q
    JOIN doctors d ON q.doctor_id = d.id
    JOIN users u ON d.user_id = u.id
    JOIN specialties s ON d.specialty_id = s.id
    WHERE q.patient_id = ? AND q.date = ? AND q.status IN ('waiting','called','in_progress')
    LIMIT 1
  `).get(userId, today);

  let waitMinutes = 0;
  if (queueEntry) {
    waitMinutes = await estimateWaitTime(queueEntry.doctor_id, queueEntry.position);
  }

  res.render('patient/queue', { title: 'حالة الطابور', queueEntry, waitMinutes, today });
});

// Notifications
router.get('/notifications', guard, async (req, res) => {
  const userId = req.session.user.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  await markAllRead(userId);
  const notifications = await getNotifications(userId, limit, offset);
  const totalRow = await db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ?').get(userId);
  const total = totalRow.cnt;

  res.render('patient/notifications', {
    title: 'الإشعارات',
    notifications,
    page,
    totalPages: Math.ceil(total / limit)
  });
});

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

module.exports = router;
