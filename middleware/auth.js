'use strict';

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    res.locals.user = req.session.user;
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/auth/login');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'غير مصرح',
        message: 'ليس لديك صلاحية الوصول إلى هذه الصفحة.',
        user: req.session.user
      });
    }
    next();
  };
}

function setLocals(req, res, next) {
  res.locals.user = req.session && req.session.user ? req.session.user : null;
  res.locals.flash = req.session.flash || {};
  delete req.session.flash;
  next();
}

module.exports = { requireAuth, requireRole, setLocals };
