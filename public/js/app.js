/* app.js — General UI interactions */
(function () {
  'use strict';

  /* ── Mobile Sidebar Toggle ────────────────────────────── */
  var sidebar    = document.getElementById('sidebar');
  var overlay    = document.getElementById('sidebar-overlay');
  var hamburger  = document.getElementById('hamburger-btn');

  function openSidebar()  { if (sidebar) { sidebar.classList.add('open'); if (overlay) overlay.classList.add('show'); } }
  function closeSidebar() { if (sidebar) { sidebar.classList.remove('open'); if (overlay) overlay.classList.remove('show'); } }

  if (hamburger) hamburger.addEventListener('click', openSidebar);
  if (overlay)   overlay.addEventListener('click', closeSidebar);

  document.querySelectorAll('.sidebar .nav-item').forEach(function(item) {
    item.addEventListener('click', function() { if (window.innerWidth <= 768) closeSidebar(); });
  });

  /* ── Auto-dismiss alerts ──────────────────────────────── */
  document.querySelectorAll('.alert').forEach(function(el) {
    var delay = el.classList.contains('alert-error') ? 10000 : 5000;
    setTimeout(function() {
      el.style.transition = 'opacity .4s ease, transform .4s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(function() { el.remove(); }, 400);
    }, delay);
  });

  /* ── Date validation ─────────────────────────────────── */
  var dateFrom = document.querySelector('input[name="date_from"]');
  var dateTo   = document.querySelector('input[name="date_to"]');
  if (dateFrom && dateTo) {
    dateFrom.addEventListener('change', function() {
      if (dateTo.value && dateTo.value < dateFrom.value) dateTo.value = dateFrom.value;
      dateTo.min = dateFrom.value;
    });
  }

  /* ── Active nav based on current path ────────────────── */
  var path = window.location.pathname;
  var bestMatch = null;
  var bestLen = 0;
  document.querySelectorAll('.nav-item').forEach(function(el) {
    var href = el.getAttribute('href');
    if (href && path.startsWith(href) && href.length > bestLen) {
      bestMatch = el;
      bestLen = href.length;
    }
  });
  if (bestMatch) bestMatch.classList.add('active');

  /* ── Confirm dialogs ─────────────────────────────────── */
  document.querySelectorAll('form[data-confirm]').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      if (!confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  /* ── Animate elements on scroll ──────────────────────── */
  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.stat-card, .section, .appt-card, .appt-card-full, .action-card, .notif-item, .notif-item-full, .queue-entry-card, .waiting-card').forEach(function(el) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    observer.observe(el);
  });
})();