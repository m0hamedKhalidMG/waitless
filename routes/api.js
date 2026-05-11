'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const { requireAuth } = require('../middleware/auth');
const { countUnread, getNotifications } = require('../utils/notifications');
const { estimateWaitTime, getDoctorQueue } = require('../utils/queue-predictor');

function localDate() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// GET /api/notifications/unread — returns unread count (polling)
router.get('/notifications/unread', requireAuth, async (req, res) => {
  const count = await countUnread(req.session.user.id);
  res.json({ count });
});

// GET /api/notifications — returns last 10 unread notifications
router.get('/notifications', requireAuth, async (req, res) => {
  const notifs = await getNotifications(req.session.user.id, 10, 0);
  res.json({ notifications: notifs });
});

// GET /api/queue/status — returns patient's current queue position and wait time
router.get('/queue/status', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const today = localDate();

  const entry = await db.prepare(`
    SELECT q.position, q.status, q.doctor_id, u.name as doctor_name
    FROM queue_entries q
    JOIN doctors d ON q.doctor_id = d.id
    JOIN users u ON d.user_id = u.id
    WHERE q.patient_id = ? AND q.date = ? AND q.status IN ('waiting','called','in_progress')
    LIMIT 1
  `).get(userId, today);

  if (!entry) return res.json({ inQueue: false });

  const waitMinutes = await estimateWaitTime(entry.doctor_id, entry.position);
  res.json({
    inQueue: true,
    position: entry.position,
    status: entry.status,
    doctorName: entry.doctor_name,
    waitMinutes
  });
});

// GET /api/doctor/queue — returns doctor's queue (for doctor dashboard polling)
router.get('/doctor/queue', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'doctor') return res.status(403).json({ error: 'Forbidden' });
  const doctorRow = await db.prepare('SELECT id FROM doctors WHERE user_id = ?').get(req.session.user.id);
  if (!doctorRow) return res.status(404).json({ error: 'Not found' });

  const date = req.query.date || localDate();
  const queue = await getDoctorQueue(doctorRow.id, date);
  res.json({ queue });
});

module.exports = router;
