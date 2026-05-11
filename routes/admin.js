'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const bcrypt = require('bcrypt');
const { requireAuth, requireRole } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

const guard = [requireAuth, requireRole('admin')];

function localDate() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// Dashboard
router.get('/dashboard', guard, async (req, res) => {
  const today = localDate();

  const totalTodayRow = await db.prepare(`SELECT COUNT(*) as cnt FROM appointments WHERE appointment_date = ? AND status NOT IN ('cancelled')`).get(today);
  const cancelledRow = await db.prepare(`SELECT COUNT(*) as cnt FROM appointments WHERE appointment_date = ? AND status = 'cancelled'`).get(today);
  const noShowRow = await db.prepare(`SELECT COUNT(*) as cnt FROM appointments WHERE appointment_date = ? AND status = 'no_show'`).get(today);
  const completedRow = await db.prepare(`SELECT COUNT(*) as cnt FROM appointments WHERE appointment_date = ? AND status = 'completed'`).get(today);
  const totalDoctorsRow = await db.prepare('SELECT COUNT(*) as cnt FROM doctors WHERE is_active = 1').get();
  const totalPatientsRow = await db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'patient'").get();
  const waitingRow = await db.prepare("SELECT COUNT(*) as cnt FROM waiting_list WHERE status IN ('waiting','notified')").get();

  const stats = {
    totalToday: totalTodayRow.cnt,
    cancelled: cancelledRow.cnt,
    noShow: noShowRow.cnt,
    completed: completedRow.cnt,
    totalDoctors: totalDoctorsRow.cnt,
    totalPatients: totalPatientsRow.cnt,
    waiting: waitingRow.cnt,
  };

  const doctorQueues = await db.prepare(`
    SELECT d.id, u.name as doctor_name, s.name as specialty_name,
           COUNT(q.id) as queue_count,
           SUM(CASE WHEN q.status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM doctors d
    JOIN users u ON d.user_id = u.id
    JOIN specialties s ON d.specialty_id = s.id
    LEFT JOIN queue_entries q ON q.doctor_id = d.id AND q.date = ?
    WHERE d.is_active = 1
    GROUP BY d.id
    ORDER BY u.name
  `).all(today);

  res.render('admin/dashboard', { title: 'لوحة الإدارة', stats, doctorQueues, today });
});

// ─── Doctors ────────────────────────────────────────────────────────────────
router.get('/doctors', guard, async (req, res) => {
  const doctors = await db.prepare(`
    SELECT d.id, d.avg_consultation_minutes, d.is_active, u.name, u.email, u.phone, s.name as specialty_name
    FROM doctors d JOIN users u ON d.user_id = u.id JOIN specialties s ON d.specialty_id = s.id
    ORDER BY u.name
  `).all();
  const specialties = await db.prepare('SELECT * FROM specialties ORDER BY name').all();
  res.render('admin/doctors', { title: 'إدارة الأطباء', doctors, specialties });
});

router.post('/doctors', guard, [
  body('name').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('phone').optional({ checkFalsy: true }),
  body('password').isLength({ min: 8 }),
  body('specialty_id').isInt(),
  body('avg_consultation_minutes').isInt({ min: 5, max: 120 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.flash = { error: errors.array().map(e => e.msg).join(', ') };
    return res.redirect('/admin/doctors');
  }

  const { name, email, phone, password, specialty_id, avg_consultation_minutes } = req.body;
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    req.session.flash = { error: 'البريد الإلكتروني مسجل مسبقاً.' };
    return res.redirect('/admin/doctors');
  }

  const hash = await bcrypt.hash(password, 12);
  await db.batch([
    { sql: 'INSERT INTO users(name,email,password_hash,phone,role) VALUES(?,?,?,?,?)', args: [name, email, hash, phone || null, 'doctor'] },
    { sql: 'INSERT INTO doctors(user_id, specialty_id, avg_consultation_minutes) VALUES(last_insert_rowid(),?,?)', args: [parseInt(specialty_id), parseInt(avg_consultation_minutes)] }
  ]);

  req.session.flash = { success: `تم إضافة الطبيب ${name} بنجاح.` };
  res.redirect('/admin/doctors');
});

router.post('/doctors/:id/toggle', guard, async (req, res) => {
  const doctor = await db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!doctor) return res.redirect('/admin/doctors');
  await db.prepare('UPDATE doctors SET is_active = ? WHERE id = ?').run(doctor.is_active ? 0 : 1, doctor.id);
  req.session.flash = { success: 'تم تحديث حالة الطبيب.' };
  res.redirect('/admin/doctors');
});

router.post('/doctors/:id/delete', guard, async (req, res) => {
  const doctor = await db.prepare('SELECT d.id, d.user_id FROM doctors d WHERE d.id = ?').get(req.params.id);
  if (!doctor) return res.redirect('/admin/doctors');
  // Clean up related records before deleting
  await db.prepare('DELETE FROM waiting_list WHERE doctor_id = ?').run(doctor.id);
  await db.prepare('DELETE FROM queue_entries WHERE doctor_id = ?').run(doctor.id);
  await db.prepare('DELETE FROM doctor_schedules WHERE doctor_id = ?').run(doctor.id);
  await db.prepare('DELETE FROM doctor_blocked_dates WHERE doctor_id = ?').run(doctor.id);
  await db.prepare('DELETE FROM appointments WHERE doctor_id = ?').run(doctor.id);
  await db.prepare('DELETE FROM doctors WHERE id = ?').run(doctor.id);
  await db.prepare('DELETE FROM users WHERE id = ?').run(doctor.user_id);
  req.session.flash = { success: 'تم حذف الطبيب.' };
  res.redirect('/admin/doctors');
});

// ─── Specialties ─────────────────────────────────────────────────────────────
router.get('/specialties', guard, async (req, res) => {
  const specialties = await db.prepare(`SELECT s.*, COUNT(d.id) as doctor_count FROM specialties s LEFT JOIN doctors d ON d.specialty_id = s.id GROUP BY s.id ORDER BY s.name`).all();
  res.render('admin/specialties', { title: 'التخصصات الطبية', specialties });
});

router.post('/specialties', guard, [body('name').trim().notEmpty()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.flash = { error: 'الاسم مطلوب.' };
    return res.redirect('/admin/specialties');
  }
  try {
    await db.prepare('INSERT INTO specialties(name) VALUES(?)').run(req.body.name.trim());
    req.session.flash = { success: 'تم إضافة التخصص.' };
  } catch (e) {
    req.session.flash = { error: 'التخصص موجود مسبقاً.' };
  }
  res.redirect('/admin/specialties');
});

router.post('/specialties/:id/delete', guard, async (req, res) => {
  const row = await db.prepare('SELECT COUNT(*) as cnt FROM doctors WHERE specialty_id = ?').get(req.params.id);
  if (row.cnt > 0) {
    req.session.flash = { error: 'لا يمكن حذف تخصص مرتبط بأطباء.' };
    return res.redirect('/admin/specialties');
  }
  await db.prepare('DELETE FROM specialties WHERE id = ?').run(req.params.id);
  req.session.flash = { success: 'تم حذف التخصص.' };
  res.redirect('/admin/specialties');
});

// ─── Appointments ────────────────────────────────────────────────────────────
router.get('/appointments', guard, async (req, res) => {
  const { date, doctor_id, status } = req.query;
  const today = localDate();
  let where = ['1=1'];
  const params = [];

  if (date)      { where.push('a.appointment_date = ?'); params.push(date); }
  else           { where.push('a.appointment_date >= ?'); params.push(today); }
  if (doctor_id) { where.push('a.doctor_id = ?'); params.push(parseInt(doctor_id)); }
  if (status)    { where.push('a.status = ?'); params.push(status); }

  const appointments = await db.prepare(`
    SELECT a.*, pu.name as patient_name, du.name as doctor_name, s.name as specialty_name
    FROM appointments a
    JOIN users pu ON a.patient_id = pu.id
    JOIN doctors d ON a.doctor_id = d.id
    JOIN users du ON d.user_id = du.id
    JOIN specialties s ON d.specialty_id = s.id
    WHERE ${where.join(' AND ')}
    ORDER BY a.appointment_date, a.appointment_time
    LIMIT 200
  `).all(...params);

  const doctors = await db.prepare('SELECT d.id, u.name FROM doctors d JOIN users u ON d.user_id = u.id ORDER BY u.name').all();
  res.render('admin/appointments', { title: 'إدارة المواعيد', appointments, doctors, filters: { date, doctor_id, status } });
});

router.post('/appointments/:id/cancel', guard, async (req, res) => {
  const { onCancellation } = require('../utils/scheduler');
  const appt = await db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (appt && ['scheduled', 'confirmed'].includes(appt.status)) {
    await db.prepare(`UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(appt.id);
    await onCancellation(appt.id);
  }
  req.session.flash = { success: 'تم إلغاء الموعد.' };
  res.redirect('/admin/appointments');
});

// ─── Reports ─────────────────────────────────────────────────────────────────
router.get('/reports', guard, async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const since = new Date(); since.setDate(since.getDate() - days);
  const sd = since;
  const sinceDate = sd.getFullYear() + '-' + String(sd.getMonth()+1).padStart(2,'0') + '-' + String(sd.getDate()).padStart(2,'0');

  const overview = await db.prepare(`
    SELECT appointment_date as date,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show
    FROM appointments
    WHERE appointment_date >= ?
    GROUP BY appointment_date
    ORDER BY appointment_date DESC
  `).all(sinceDate);

  const perDoctor = await db.prepare(`
    SELECT u.name as doctor_name, s.name as specialty_name,
      COUNT(a.id) as total,
      SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) as no_show,
      ROUND(SUM(CASE WHEN a.status = 'no_show' THEN 1.0 ELSE 0 END) / COUNT(a.id) * 100, 1) as no_show_pct
    FROM appointments a
    JOIN doctors d ON a.doctor_id = d.id
    JOIN users u ON d.user_id = u.id
    JOIN specialties s ON d.specialty_id = s.id
    WHERE a.appointment_date >= ?
    GROUP BY d.id
    ORDER BY total DESC
  `).all(sinceDate);

  res.render('admin/reports', { title: 'التقارير', overview, perDoctor, days });
});

// ─── Waiting List ────────────────────────────────────────────────────────────
router.get('/waiting-list', guard, async (req, res) => {
  const list = await db.prepare(`
    SELECT wl.*, pu.name as patient_name, du.name as doctor_name, s.name as specialty_name
    FROM waiting_list wl
    JOIN users pu ON wl.patient_id = pu.id
    JOIN doctors d ON wl.doctor_id = d.id
    JOIN users du ON d.user_id = du.id
    JOIN specialties s ON d.specialty_id = s.id
    WHERE wl.status IN ('waiting','notified')
    ORDER BY wl.created_at
  `).all();
  res.render('admin/waiting-list', { title: 'قائمة الانتظار', list });
});

module.exports = router;
