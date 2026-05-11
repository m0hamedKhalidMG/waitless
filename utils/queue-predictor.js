'use strict';
const db = require('../db/connection');

/**
 * Get the current position of a patient in today's queue for a specific doctor.
 */
async function getQueuePosition(patientId, doctorId, date) {
  const entry = await db.prepare(`
    SELECT position, status FROM queue_entries
    WHERE patient_id = ? AND doctor_id = ? AND date = ? AND status IN ('waiting','called')
  `).get(patientId, doctorId, date);
  return entry || null;
}

/**
 * Get historical statistics for a doctor over the last N days.
 * Returns: avg actual consultation duration, delay factor, no-show rate.
 */
async function getHistoricalStats(doctorId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceDate = since.getFullYear() + '-' + String(since.getMonth()+1).padStart(2,'0') + '-' + String(since.getDate()).padStart(2,'0');

  // Avg actual consultation time in minutes (from completed queue entries)
  const durationRow = await db.prepare(`
    SELECT AVG(
      (strftime('%s', completed_time) - strftime('%s', called_time)) / 60.0
    ) as avg_actual
    FROM queue_entries
    WHERE doctor_id = ? AND date >= ? AND status = 'completed'
      AND called_time IS NOT NULL AND completed_time IS NOT NULL
  `).get(doctorId, sinceDate);

  // Doctor's configured avg consultation minutes
  const doctorRow = await db.prepare('SELECT avg_consultation_minutes FROM doctors WHERE id = ?').get(doctorId);
  const configuredAvg = doctorRow ? doctorRow.avg_consultation_minutes : 15;

  const avgActual = durationRow.avg_actual || configuredAvg;

  // Delay factor: actual / configured (if > 1, doctor runs late)
  const delayFactor = avgActual / configuredAvg;

  // No-show rate: no_show / (completed + no_show)
  const noShowRow = await db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_shows,
      SUM(CASE WHEN status IN ('completed','no_show') THEN 1 ELSE 0 END) as total
    FROM queue_entries
    WHERE doctor_id = ? AND date >= ?
  `).get(doctorId, sinceDate);

  const noShowRate = noShowRow.total > 0 ? noShowRow.no_shows / noShowRow.total : 0.1;

  return {
    avgActualMinutes: Math.round(avgActual),
    configuredAvg,
    delayFactor: Math.max(1, delayFactor),
    noShowRate: Math.min(0.5, noShowRate)   // cap at 50%
  };
}

/**
 * Estimate wait time in minutes for a patient at a given queue position.
 */
async function estimateWaitTime(doctorId, position) {
  if (!position || position <= 0) return 0;
  const { avgActualMinutes, delayFactor, noShowRate } = await getHistoricalStats(doctorId);
  // Effective position reduced by expected no-shows
  const effectivePosition = Math.max(1, Math.round(position * (1 - noShowRate)));
  return Math.round(effectivePosition * avgActualMinutes * delayFactor);
}

/**
 * Get full queue for a doctor on a specific date.
 */
async function getDoctorQueue(doctorId, date) {
  return await db.prepare(`
    SELECT q.*, u.name as patient_name, u.phone as patient_phone,
           a.appointment_time, a.notes
    FROM queue_entries q
    JOIN users u ON q.patient_id = u.id
    LEFT JOIN appointments a ON q.appointment_id = a.id
    WHERE q.doctor_id = ? AND q.date = ?
    ORDER BY q.position
  `).all(doctorId, date);
}

/**
 * Recalculate and compact queue positions after a status change.
 */
async function reorderQueue(doctorId, date) {
  const entries = await db.prepare(`
    SELECT id FROM queue_entries
    WHERE doctor_id = ? AND date = ? AND status = 'waiting'
    ORDER BY position
  `).all(doctorId, date);

  const stmts = entries.map((e, i) => ({
    sql: 'UPDATE queue_entries SET position = ? WHERE id = ?',
    args: [i + 1, e.id]
  }));
  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

/**
 * Check in a patient: create a queue entry or confirm their slot.
 */
async function checkIn(patientId, doctorId, appointmentId, date) {
  // Determine next position
  const maxPosRow = await db.prepare(`
    SELECT COALESCE(MAX(position), 0) as mx FROM queue_entries
    WHERE doctor_id = ? AND date = ?
  `).get(doctorId, date);
  const maxPos = maxPosRow.mx;

  const existing = await db.prepare(`
    SELECT id FROM queue_entries WHERE appointment_id = ? AND date = ?
  `).get(appointmentId, date);

  if (existing) return existing.id;

  const { lastInsertRowid } = await db.prepare(`
    INSERT INTO queue_entries(patient_id, doctor_id, appointment_id, check_in_time, position, status, date)
    VALUES(?, ?, ?, datetime('now'), ?, 'waiting', ?)
  `).run(patientId, doctorId, appointmentId, maxPos + 1, date);

  return lastInsertRowid;
}

module.exports = { getQueuePosition, getHistoricalStats, estimateWaitTime, getDoctorQueue, reorderQueue, checkIn };
