/* polling.js — Polling for patient notifications and queue status */
(function () {
  'use strict';

  // ── Notification badge polling (every 60 seconds) ──────────────────
  let notifFailCount = 0;
  function pollNotifications() {
    fetch('/api/notifications/unread')
      .then(r => r.json())
      .then(data => {
        notifFailCount = 0;
        const badge = document.getElementById('notif-badge');
        const topCount = document.getElementById('notif-count-top');
        if (badge) {
          if (data.count > 0) {
            badge.textContent = data.count;
            badge.style.display = 'inline';
          } else {
            badge.style.display = 'none';
          }
        }
        if (topCount) {
          topCount.textContent = data.count > 0 ? `(${data.count})` : '';
        }
      })
      .catch(() => { notifFailCount++; });
  }

  // ── Queue status polling (every 30 seconds on the queue page) ─────
  function pollQueueStatus() {
    fetch('/api/queue/status')
      .then(r => r.json())
      .then(data => {
        if (!data.inQueue) return;

        const posEl = document.querySelector('.pos-num');
        const waitEl = document.querySelector('.q-stat-val');
        const lastEl = document.getElementById('last-updated');

        if (posEl) posEl.textContent = '#' + data.position;
        if (waitEl) waitEl.textContent = data.waitMinutes;
        if (lastEl) lastEl.textContent = 'آخر تحديث: ' + new Date().toLocaleTimeString('ar-SA');
      })
      .catch(() => {
        const lastEl = document.getElementById('last-updated');
        if (lastEl) lastEl.textContent = 'آخر تحديث: فشل الاتصال';
      });
  }

  // Start polling
  pollNotifications();
  setInterval(pollNotifications, 60000);

  if (window.WAITLESS_QUEUE) {
    pollQueueStatus();
    setInterval(pollQueueStatus, 30000);
  }

  // ── Offer countdown timer ──────────────────────────────────────────
  function startCountdowns() {
    document.querySelectorAll('[data-expires]').forEach(el => {
      const expiresAt = new Date(el.dataset.expires);
      function tick() {
        const diff = expiresAt - Date.now();
        if (diff <= 0) { el.textContent = 'انتهت الصلاحية'; return; }
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        el.textContent = `ينتهي خلال ${mins}:${String(secs).padStart(2,'0')} دقيقة`;
        setTimeout(tick, 1000);
      }
      tick();
    });
  }

  startCountdowns();
})();
