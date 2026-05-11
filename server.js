'use strict';
require('dotenv').config();

const express       = require('express');
const path          = require('path');
const session       = require('express-session');
const ConnectSQLite = require('connect-sqlite3')(session);
const helmet        = require('helmet');

const ejs           = require('ejs');

const { setLocals }     = require('./middleware/auth');
const authRoutes         = require('./routes/auth');
const patientRoutes      = require('./routes/patient');
const doctorRoutes       = require('./routes/doctor');
const adminRoutes        = require('./routes/admin');
const apiRoutes          = require('./routes/api');
const { seed }           = require('./db/seed');
const { processExpiredOffers } = require('./utils/scheduler');
const { sendAppointmentReminders } = require('./utils/notifications');

const app  = express();
const PORT = process.env.PORT || 3000;



// ── Security ────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:'],
    }
  }
}));

// ── Body parsing ─────────────────────────────────────────
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));

// ── Session ──────────────────────────────────────────────
const sessionStore = new ConnectSQLite({
  db: 'sessions.db',
  dir: path.join(__dirname, 'data')
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'wl-secret-change-in-production-32chars',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000   // 1 day
  },
  name: 'wl.sid'
}));

// ── View engine ──────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Custom EJS layout wrapper: wraps every render in layout.ejs
const originalRender = app.response.render;
app.use((req, res, next) => {
  const _render = res.render.bind(res);
  res.render = function (view, opts, fn) {
    const options = (typeof opts === 'object' ? opts : {}) || {};
    // Render the inner view to a string, then inject into layout
    ejs.renderFile(
      path.join(__dirname, 'views', view + (view.endsWith('.ejs') ? '' : '.ejs')),
      { ...res.locals, ...options },
      {},
      (err, body) => {
        if (err) return next(err);
        ejs.renderFile(
          path.join(__dirname, 'views', 'layout.ejs'),
          { ...res.locals, ...options, body, title: options.title || 'Wait Less' },
          {},
          (err2, html) => {
            if (err2) return next(err2);
            res.send(html);
          }
        );
      }
    );
  };
  next();
});

// ── Static files ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true
}));

// ── Global locals (flash, user) ──────────────────────────
app.use(setLocals);

// ── Routes ───────────────────────────────────────────────
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  const role = req.session.user.role;
  if (role === 'admin')  return res.redirect('/admin/dashboard');
  if (role === 'doctor') return res.redirect('/doctor/dashboard');
  return res.redirect('/patient/dashboard');
});

app.use('/auth',    authRoutes);
app.use('/patient', patientRoutes);
app.use('/doctor',  doctorRoutes);
app.use('/admin',   adminRoutes);
app.use('/api',     apiRoutes);

// ── 404 ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', { title: 'الصفحة غير موجودة', message: 'الصفحة التي تبحث عنها غير موجودة.' });
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { title: 'خطأ في الخادم', message: 'حدث خطأ داخلي. يرجى المحاولة لاحقاً.' });
});

// ── Seed database on startup ─────────────────────────────
seed();

// ── Background tasks ─────────────────────────────────────
setInterval(() => {
  try { processExpiredOffers(); } catch (e) { console.error('processExpiredOffers error:', e.message); }
}, 5 * 60 * 1000);   // every 5 minutes

setInterval(() => {
  try { sendAppointmentReminders(); } catch (e) { console.error('sendAppointmentReminders error:', e.message); }
}, 60 * 1000);        // every 1 minute

// ── Export for serverless (Vercel) ───────────────────────
module.exports = app;

// ── Start server locally ─────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n✅ Wait Less server running at http://localhost:${PORT}`);
    console.log(`   Admin:   admin@waitless.com  / Admin@12345`);
    console.log(`   Doctor:  ahmed@waitless.com  / Doctor@123`);
    console.log(`   Patient: mohammed@example.com/ Patient@123\n`);
  });
}
