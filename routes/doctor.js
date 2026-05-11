'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDoctorQueue, reorderQueue } = require('../utils/queue-predictor');
const { createNotification } = require('../utils/notifications');

const guard = [requireAuth, requireRole('doctor')];

function localDate() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const p1 = parseInt(slashMatch[1], 10);
    const p2 = parseInt(slashMatch[2], 10);
    const year = parseInt(slashMatch[3], 10);
    const month = p1 > 12 ? p2 : p1;
    const day   = p1 > 12 ? p1 : p2;
    return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

async function getDoctorId(userId) {
  const row = await db.prepare('SELECT id FROM doctors WHERE user_id = ?').get(userId);
  return row ? row.id : null;
}

// Dashboard
router.get('/dashboard', guard, async (req, res) => {
  const doctorId = await getDoctorId(req.session.user.id);
  if (!doctorId) return res.status(404).send('الطبيب غير موجود');
  const today = localDate();
  const selectedDate = normalizeDate(req.query.date) || today;

  const todayAppointments = await db.prepare(`
    SELECT a.*, u.name as patient_name, u.phone as patient_phone
    FROM appointments a JOIN users u ON a.patient_id = u.id
    WHERE a.doctor_id = ? AND a.appointment_date = ? AND a.status NOT IN ('cancelled','no_show')
    ORDER BY a.appointment_time
  `).all(doctorId, selectedDate);

  const queue = await getDoctorQueue(doctorId, selectedDate);
  const stats = {
    total: todayAppointments.length,
    seen: queue.filter(q => q.status === 'completed').length,
    noShow: queue.filter(q => q.status === 'no_show').length,
    remaining: queue.filter(q => ['waiting', 'called'].includes(q.status)).length
  };

  res.render('doctor/dashboard', { title: 'لوحة الطبيب', todayAppointments, queue, stats, today, selectedDate });
});

// Queue management page
router.get('/queue', guard, async (req, res) => {
  const doctorId = await getDoctorId(req.session.user.id);
  if (!doctorId) return res.redirect('/doctor/dashboard');
  const date = normalizeDate(req.query.date) || localDate();
  const queue = await getDoctorQueue(doctorId, date);

  // Fetch appointments for the selected date
  const appointments = await db.prepare(`
    SELECT a.*, u.name as patient_name, u.phone as patient_phone
    FROM appointments a JOIN users u ON a.patient_id = u.id
    WHERE a.doctor_id = ? AND a.appointment_date = ? AND a.status NOT IN ('cancelled','no_show')
    ORDER BY a.appointment_time
  `).all(doctorId, date);

  res.render('doctor/queue', { title: 'إدارة الطابور', queue, date, doctorId, appointments });
});

// Check in a patient (create queue entry)
router.post('/queue/checkin/:appointmentId', guard, async (req, res) => {
  const doctorId = await getDoctorId(req.session.user.id);
  const appt = await db.prepare('SELECT * FROM appointments WHERE id = ? AND doctor_id = ?')
    .get(req.params.appointmentId, doctorId);
  if (!appt) return res.redirect('/doctor/queue');

  const apptDate = appt.appointment_date;
  const existing = await db.prepare('SELECT id FROM queue_entries WHERE appointment_id = ? AND date = ?').get(appt.id, apptDate);
  if (!existing) {
    const maxPosRow = await db.prepare('SELECT COALESCE(MAX(position),0) as mx FROM queue_entries WHERE doctor_id = ? AND date = ?').get(doctorId, apptDate);
    const maxPos = maxPosRow.mx;
    await db.prepare(`INSERT INTO queue_entries(patient_id, doctor_id, appointment_id, check_in_time, position, status, date) VALUES(?,?,?,datetime('now'),?,'waiting',?)`)
      .run(appt.patient_id, doctorId, appt.id, maxPos + 1, apptDate);
    await db.prepare(`UPDATE appointments SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`).run(appt.id);
  }

  const redirect = req.headers.referer || '/doctor/queue';
  res.redirect(redirect);
});

// Update queue entry status
router.post('/queue/:entryId/status', guard, async (req, res) => {
  const doctorId = await getDoctorId(req.session.user.id);
  const { status } = req.body;
  const allowed = ['called', 'in_progress', 'completed', 'no_show'];
  if (!allowed.includes(status)) return res.redirect('/doctor/queue');

  const entry = await db.prepare('SELECT * FROM queue_entries WHERE id = ? AND doctor_id = ?').get(req.params.entryId, doctorId);
  if (!entry) return res.redirect('/doctor/queue');

  // Validate status transition
  const validTransitions = {
    'waiting': ['called', 'no_show'],
    'called': ['in_progress', 'no_show'],
    'in_progress': ['completed', 'no_show']
  };
  const allowedNext = validTransitions[entry.status] || [];
  if (!allowedNext.includes(status)) {
    req.session.flash = { error: 'لا يمكن تغيير الحالة بهذه الطريقة.' };
    return res.redirect('/doctor/queue?date=' + entry.date);
  }

  const timeFields = {};
  if (status === 'called')      timeFields.called_time = "datetime('now')";
  if (status === 'completed')   timeFields.completed_time = "datetime('now')";
  if (status === 'no_show')     timeFields.completed_time = "datetime('now')";

  let setClause = `status = '${status}'`;
  if (timeFields.called_time)    setClause += `, called_time = datetime('now')`;
  if (timeFields.completed_time) setClause += `, completed_time = datetime('now')`;

  await db.prepare(`UPDATE queue_entries SET ${setClause} WHERE id = ?`).run(entry.id);

  // Update related appointment status
  if (status === 'completed') {
    await db.prepare(`UPDATE appointments SET status = 'completed', updated_at = datetime('now') WHERE id = ?`).run(entry.appointment_id);
  } else if (status === 'no_show') {
    await db.prepare(`UPDATE appointments SET status = 'no_show', updated_at = datetime('now') WHERE id = ?`).run(entry.appointment_id);
  } else if (status === 'in_progress') {
    await db.prepare(`UPDATE appointments SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`).run(entry.appointment_id);
  }

  // Reorder remaining queue
  if (['completed', 'no_show'].includes(status)) {
    await reorderQueue(doctorId, entry.date);

    // Notify patient their position moved
    const nextEntry = await db.prepare('SELECT * FROM queue_entries WHERE doctor_id = ? AND date = ? AND status = ? AND position = 1').get(doctorId, entry.date, 'waiting');
    if (nextEntry) {
      await createNotification({
        userId: nextEntry.patient_id,
        title: 'حان دورك قريباً',
        message: 'أنت الآن في المقدمة. يرجى التوجه إلى العيادة.',
        type: 'queue_update',
        relatedAppointmentId: nextEntry.appointment_id
      });
    }
  }

  res.redirect('/doctor/queue?date=' + entry.date);
});

// Doctor schedule
router.get('/schedule', guard, async (req, res) => {
  const doctorId = await getDoctorId(req.session.user.id);
  const schedules = await db.prepare('SELECT * FROM doctor_schedules WHERE doctor_id = ? ORDER BY day_of_week').all(doctorId);
  const blockedDates = await db.prepare('SELECT * FROM doctor_blocked_dates WHERE doctor_id = ? ORDER BY blocked_date').all(doctorId);
  const dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  res.render('doctor/schedule', { title: 'جدولي الأسبوعي', schedules, blockedDates, dayNames, doctorId, today: localDate() });
});

// Update schedule for a day
router.post('/schedule', guard, async (req, res) => {
  const doctorId = await getDoctorId(req.session.user.id);
  const { day_of_week, start_time, end_time, slot_duration, remove } = req.body;

  const day = parseInt(day_of_week);
  if (remove === '1') {
    await db.prepare('DELETE FROM doctor_schedules WHERE doctor_id = ? AND day_of_week = ?').run(doctorId, day);
  } else {
    const existing = await db.prepare('SELECT id FROM doctor_schedules WHERE doctor_id = ? AND day_of_week = ?').get(doctorId, day);
    if (existing) {
      await db.prepare('UPDATE doctor_schedules SET start_time=?, end_time=?, slot_duration_minutes=? WHERE doctor_id=? AND day_of_week=?')
        .run(start_time, end_time, parseInt(slot_duration) || 15, doctorId, day);
    } else {
      await db.prepare('INSERT INTO doctor_schedules(doctor_id, day_of_week, start_time, end_time, slot_duration_minutes) VALUES(?,?,?,?,?)')
        .run(doctorId, day, start_time, end_time, parseInt(slot_duration) || 15);
    }
  }
  req.session.flash = { success: 'تم تحديث الجدول.' };
  res.redirect('/doctor/schedule');
});

// Block a date
router.post('/schedule/block', guard, async (req, res) => {
  const doctorId = await getDoctorId(req.session.user.id);
  const { blocked_date, reason } = req.body;
  if (!blocked_date) return res.redirect('/doctor/schedule');

  await db.prepare('INSERT OR IGNORE INTO doctor_blocked_dates(doctor_id, blocked_date, reason) VALUES(?,?,?)').run(doctorId, blocked_date, reason || null);
  req.session.flash = { success: 'تم حظر اليوم.' };
  res.redirect('/doctor/schedule');
});

// Unblock a date
router.post('/schedule/unblock/:id', guard, async (req, res) => {
  const doctorId = await getDoctorId(req.session.user.id);
  await db.prepare('DELETE FROM doctor_blocked_dates WHERE id = ? AND doctor_id = ?').run(req.params.id, doctorId);
  req.session.flash = { success: 'تم إلغاء الحظر.' };
  res.redirect('/doctor/schedule');
});

module.exports = router;
