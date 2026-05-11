'use strict';
const db = require('../db/connection');

/**
 * Create a notification for a user.
 */
function createNotification({ userId, title, message, type, relatedAppointmentId = null, relatedWaitingId = null }) {
  db.prepare(`
    INSERT INTO notifications(user_id, title, message, type, related_appointment_id, related_waiting_id)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(userId, title, message, type, relatedAppointmentId, relatedWaitingId);
}

/**
 * Count unread notifications for a user.
 */
function countUnread(userId) {
  return db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).cnt;
}

/**
 * Mark all notifications as read for a user.
 */
function markAllRead(userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
}

/**
 * Mark a single notification as read.
 */
function markRead(id, userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, userId);
}

/**
 * Get paginated notifications for a user.
 */
function getNotifications(userId, limit = 30, offset = 0) {
  return db.prepare(`
    SELECT n.*, a.appointment_date, a.appointment_time, a.doctor_id,
           u.name as doctor_user_name, s.name as specialty_name,
           wl.status as waiting_status
    FROM notifications n
    LEFT JOIN appointments a ON n.related_appointment_id = a.id
    LEFT JOIN doctors doc ON a.doctor_id = doc.id
    LEFT JOIN users u ON doc.user_id = u.id
    LEFT JOIN specialties s ON doc.specialty_id = s.id
    LEFT JOIN waiting_list wl ON n.related_waiting_id = wl.id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
}

/**
 * Send appointment reminder notifications (called by background task).
 * Finds appointments starting in 30 minutes and notifies patients if not already notified.
 */
function sendAppointmentReminders() {
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 60 * 1000);

  // Format: YYYY-MM-DD and HH:MM (local time)
  const targetDate = soon.getFullYear() + '-' + String(soon.getMonth()+1).padStart(2,'0') + '-' + String(soon.getDate()).padStart(2,'0');
  const targetTime = soon.toTimeString().slice(0, 5);

  // Find appointments in ~30min window (within ±5 min tolerance)
  const appointments = db.prepare(`
    SELECT a.*, u.name as patient_name, du.name as doctor_name
    FROM appointments a
    JOIN users u ON a.patient_id = u.id
    JOIN doctors d ON a.doctor_id = d.id
    JOIN users du ON d.user_id = du.id
    WHERE a.appointment_date = ?
      AND a.appointment_time BETWEEN ? AND ?
      AND a.status IN ('scheduled','confirmed')
  `).all(targetDate, targetTime, addMinutes(targetTime, 5));

  for (const appt of appointments) {
    // Check if reminder already sent
    const already = db.prepare(`
      SELECT id FROM notifications
      WHERE user_id = ? AND related_appointment_id = ? AND type = 'appointment_reminder'
    `).get(appt.patient_id, appt.id);

    if (!already) {
      createNotification({
        userId: appt.patient_id,
        title: 'تذكير بموعدك',
        message: `موعدك مع ${appt.doctor_name} بعد 30 دقيقة (${appt.appointment_time}).`,
        type: 'appointment_reminder',
        relatedAppointmentId: appt.id
      });
    }
  }
}

function addMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

module.exports = { createNotification, countUnread, markAllRead, markRead, getNotifications, sendAppointmentReminders };
