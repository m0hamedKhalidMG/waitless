'use strict';
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const db = require('../db/connection');

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { title: 'تسجيل الدخول', errors: [], old: {} });
});

// POST /auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('البريد الإلكتروني غير صحيح'),
  body('password').notEmpty().withMessage('كلمة المرور مطلوبة')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('auth/login', { title: 'تسجيل الدخول', errors: errors.array(), old: req.body });
  }

  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.render('auth/login', {
      title: 'تسجيل الدخول',
      errors: [{ msg: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }],
      old: { email }
    });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).send('خطأ في الجلسة');
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    const returnTo = req.session.returnTo || roleHome(user.role);
    delete req.session.returnTo;
    res.redirect(returnTo);
  });
});

// GET /auth/register  (patients only)
router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/register', { title: 'إنشاء حساب', errors: [], old: {} });
});

// POST /auth/register
router.post('/register', [
  body('name').trim().notEmpty().withMessage('الاسم مطلوب').isLength({ max: 100 }),
  body('email').isEmail().normalizeEmail().withMessage('البريد الإلكتروني غير صحيح'),
  body('phone').optional({ checkFalsy: true }).isMobilePhone('ar-SA').withMessage('رقم الجوال غير صحيح'),
  body('password').isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل'),
  body('confirm_password').custom((val, { req: r }) => {
    if (val !== r.body.password) throw new Error('كلمة المرور غير متطابقة');
    return true;
  })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('auth/register', { title: 'إنشاء حساب', errors: errors.array(), old: req.body });
  }

  const { name, email, phone, password } = req.body;

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.render('auth/register', {
      title: 'إنشاء حساب',
      errors: [{ msg: 'هذا البريد الإلكتروني مسجل مسبقاً' }],
      old: req.body
    });
  }

  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare('INSERT INTO users(name, email, password_hash, phone, role) VALUES(?,?,?,?,?)').run(name, email, hash, phone || null, 'patient');

  req.session.regenerate((err) => {
    if (err) return res.status(500).send('خطأ في الجلسة');
    req.session.user = { id: result.lastInsertRowid, name, email, role: 'patient' };
    res.redirect('/patient/dashboard');
  });
});

// GET /auth/logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'));
});

function roleHome(role) {
  switch (role) {
    case 'admin':   return '/admin/dashboard';
    case 'doctor':  return '/doctor/dashboard';
    default:        return '/patient/dashboard';
  }
}

module.exports = router;
