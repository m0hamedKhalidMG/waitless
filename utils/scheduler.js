'use strict';
const db = require('../db/connection');
const { createNotification } = require('./notifications');

/**
 * Convert HH:MM time string to minutes since midnight.
 */
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Convert minutes since midnight to HH:MM string.
 */
function minutesToTime(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Generate all possible time slots for a doctor on a given date (YYYY-MM-DD).
 * Returns array of { start, end } objects.
 */
async function generateSlots(doctorId, date) {
  const d = new Date(date + 'T00:00:00');
  const dayOfWeek = d.getDay(); // 0=Sun … 6=Sat

  const sched = await db.prepare(`
    SELECT start_time, end_time, slot_duration_minutes
    FROM doctor_schedules
    WHERE doctor_id = ? AND day_of_week = ?
  `).get(doctorId, dayOfWeek);

  if (!sched) return [];

  // Check if blocked
  const blocked = await db.prepare(`
    SELECT id FROM doctor_blocked_dates WHERE doctor_id = ? AND blocked_date = ?
  `).get(doctorId, date);
  if (blocked) return [];

  const slots = [];
  const start = timeToMinutes(sched.start_time);
  const end   = timeToMinutes(sched.end_time);
  const dur   = sched.slot_duration_minutes;

  for (let s = start; s + dur <= end; s += dur) {
    slots.push({ start: minutesToTime(s), end: minutesToTime(s + dur) });
  }
  return slots;
}

/**
 * Get booked time slots for a doctor on a date (only active appointments).
 */
async function getBookedSlots(doctorId, date) {
  return await db.prepare(`
    SELECT appointment_time as start, end_time as end
    FROM appointments
    WHERE doctor_id = ? AND appointment_date = ?
      AND status NOT IN ('cancelled','no_show')
  `).all(doctorId, date);
}

/**
 * Format a Date object as YYYY-MM-DD using local timezone (not UTC).
 */
function localDateStr(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/**
 * Get available (unbooked) slots for a doctor starting from a given date.
 * @param {number} doctorId
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} toDate   - YYYY-MM-DD
 * @param {number} limit    - max number of slots to return
 */
async function getAvailableSlots(doctorId, fromDate, toDate, limit = 10) {
  const available = [];
  const cursor = new Date(fromDate + 'T00:00:00');
  const stop   = new Date(toDate   + 'T00:00:00');
  const today  = localDateStr(new Date());
  const nowTime= new Date().toTimeString().slice(0, 5);

  while (cursor <= stop && available.length < limit) {
    const dateStr = localDateStr(cursor);
    const slots   = await generateSlots(doctorId, dateStr);
    const booked  = await getBookedSlots(doctorId, dateStr);
    const bookedSet = new Set(booked.map(b => b.start));

    for (const slot of slots) {
      if (bookedSet.has(slot.start)) continue;
      // Skip past slots for today
      if (dateStr === today && slot.start <= nowTime) continue;
      available.push({ date: dateStr, ...slot });
      if (available.length >= limit) break;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return available;
}

/**
 * Find the best (nearest) available slot across all doctors of a specialty.
 * @param {number} specialtyId
 * @param {string} fromDate
 */
async function suggestBestSlot(specialtyId, fromDate) {
  const doctors = await db.prepare(`
    SELECT d.id as doctor_id, u.name as doctor_name, s.name as specialty_name
    FROM doctors d
    JOIN users u ON d.user_id = u.id
    JOIN specialties s ON d.specialty_id = s.id
    WHERE d.specialty_id = ? AND d.is_active = 1
  `).all(specialtyId);

  const toDate = new Date(fromDate);
  toDate.setDate(toDate.getDate() + 30);
  const toDateStr = localDateStr(toDate);

  const allSlots = [];
  for (const doc of doctors) {
    const slots = await getAvailableSlots(doc.doctor_id, fromDate, toDateStr, 5);
    slots.forEach(s => allSlots.push({ ...s, doctorId: doc.doctor_id, doctorName: doc.doctor_name }));
  }

  allSlots.sort((a, b) => {
    const da = a.date + 'T' + a.start;
    const db2 = b.date + 'T' + b.start;
    return da.localeCompare(db2);
  });

  return allSlots.slice(0, 5);
}

/**
 * Called when an appointment is cancelled.
 * Finds waiting list patients for that doctor and notifies the first one.
 */
async function onCancellation(appointmentId) {
  const appt = await db.prepare(`
    SELECT * FROM appointments WHERE id = ?
  `).get(appointmentId);
  if (!appt) return;

  // Find first waiting patient for this doctor whose preferred range covers the freed date
  const waiter = await db.prepare(`
    SELECT wl.*, u.name as patient_name
    FROM waiting_list wl
    JOIN users u ON wl.patient_id = u.id
    WHERE wl.doctor_id = ?
      AND wl.status = 'waiting'
      AND wl.preferred_date_from <= ?
      AND wl.preferred_date_to   >= ?
    ORDER BY wl.created_at
    LIMIT 1
  `).get(appt.doctor_id, appt.appointment_date, appt.appointment_date);

  if (!waiter) return;

  const expD = new Date(Date.now() + 30 * 60 * 1000);
  const expiresAt = localDateStr(expD) + ' ' + String(expD.getHours()).padStart(2,'0') + ':' + String(expD.getMinutes()).padStart(2,'0');

  // Update waiting list entry to notified
  await db.prepare(`
    UPDATE waiting_list
    SET status = 'notified', offered_appointment_id = ?, notified_at = datetime('now'), expires_at = ?
    WHERE id = ?
  `).run(appointmentId, expiresAt, waiter.id);

  // Re-mark the freed slot as 'scheduled' (hold it)
  await db.prepare(`UPDATE appointments SET status = 'scheduled', patient_id = ? WHERE id = ?`)
    .run(waiter.patient_id, appointmentId);

  // Notify patient
  await createNotification({
    userId: waiter.patient_id,
    title: 'موعد جديد متاح!',
    message: `توفر موعد بتاريخ ${appt.appointment_date} الساعة ${appt.appointment_time}. لديك 30 دقيقة لتأكيد الحجز.`,
    type: 'slot_available',
    relatedAppointmentId: appointmentId,
    relatedWaitingId: waiter.id
  });
}

/**
 * Process expired waiting list offers (called every 5 minutes).
 * If a patient didn't confirm in time, offer slot to the next patient.
 */
async function processExpiredOffers() {
  const expired = await db.prepare(`
    SELECT * FROM waiting_list
    WHERE status = 'notified' AND expires_at <= datetime('now')
  `).all();

  for (const entry of expired) {
    // Cancel the hold — reset the appointment back to availability check
    await db.prepare(`UPDATE waiting_list SET status = 'expired' WHERE id = ?`).run(entry.id);

    // Free up the appointment so next waiter can get it
    if (entry.offered_appointment_id) {
      const appt = await db.prepare('SELECT * FROM appointments WHERE id = ?').get(entry.offered_appointment_id);
      if (appt) {
        // Find next waiter
        const nextWaiter = await db.prepare(`
          SELECT wl.*, u.name as patient_name
          FROM waiting_list wl
          JOIN users u ON wl.patient_id = u.id
          WHERE wl.doctor_id = ?
            AND wl.status = 'waiting'
            AND wl.id != ?
            AND wl.preferred_date_from <= ?
            AND wl.preferred_date_to   >= ?
          ORDER BY wl.created_at
          LIMIT 1
        `).get(appt.doctor_id, entry.id, appt.appointment_date, appt.appointment_date);

        if (nextWaiter) {
          const nExpD = new Date(Date.now() + 30 * 60 * 1000);
          const newExpiry = localDateStr(nExpD) + ' ' + String(nExpD.getHours()).padStart(2,'0') + ':' + String(nExpD.getMinutes()).padStart(2,'0');
          await db.prepare(`
            UPDATE waiting_list
            SET status = 'notified', offered_appointment_id = ?, notified_at = datetime('now'), expires_at = ?
            WHERE id = ?
          `).run(entry.offered_appointment_id, newExpiry, nextWaiter.id);

          await db.prepare(`UPDATE appointments SET patient_id = ? WHERE id = ?`)
            .run(nextWaiter.patient_id, entry.offered_appointment_id);

          await createNotification({
            userId: nextWaiter.patient_id,
            title: 'موعد جديد متاح!',
            message: `توفر موعد بتاريخ ${appt.appointment_date} الساعة ${appt.appointment_time}. لديك 30 دقيقة لتأكيد الحجز.`,
            type: 'slot_available',
            relatedAppointmentId: entry.offered_appointment_id,
            relatedWaitingId: nextWaiter.id
          });
        } else {
          // No one waiting — free the appointment slot (cancel it)
          await db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`)
            .run(entry.offered_appointment_id);
        }
      }
    }
  }
}

module.exports = {
  getAvailableSlots,
  suggestBestSlot,
  onCancellation,
  processExpiredOffers,
  generateSlots,
  getBookedSlots
};
