# Wait Less — خطة المشروع

## وصف المشروع
نظام ويب كامل بـ Node.js + SQLite + EJS (عربي RTL) لإدارة مواعيد المستشفيات وطوابير الانتظار بشكل ذكي.
ثلاثة أدوار: مريض، طبيب، مدير. جدولة ذكية، تنبؤ بالانتظار، إشعارات بالـ Polling.

## التقنيات
- **Backend**: Node.js + Express.js
- **Database**: SQLite (better-sqlite3)
- **Templating**: EJS (Server-rendered)
- **Auth**: Email + Password, bcrypt, express-session
- **Frontend**: HTML/CSS (RTL عربي), Vanilla JS (Polling)
- **بدون**: Socket.IO، أطر عمل أمامية

---

## Phase 1: إعداد المشروع وقاعدة البيانات

### Step 1 — تهيئة المشروع
- `npm init` + تثبيت الحزم: express, better-sqlite3, ejs, bcrypt, express-session, dotenv, helmet, express-validator, express-rate-limit
- هيكل المجلدات:
  ```
  /wait-less
    /public (css, js, images)
    /views (ejs templates)
    /routes (auth, patient, doctor, admin, api)
    /middleware (auth, role-guard)
    /db (schema.sql, seed.sql, connection.js)
    /utils (scheduler.js, queue-predictor.js, notifications.js)
    server.js
    .env
  ```

### Step 2 — مخطط قاعدة البيانات (8 جداول)
| الجدول | الوصف |
|---|---|
| `users` | بيانات المستخدمين (الدور: patient/doctor/admin) |
| `specialties` | التخصصات الطبية |
| `doctors` | ملف الطبيب + متوسط مدة الكشف |
| `doctor_schedules` | جدول العمل الأسبوعي |
| `appointments` | المواعيد (scheduled/confirmed/completed/cancelled/no_show) |
| `waiting_list` | قائمة الانتظار مع صلاحية العرض |
| `notifications` | الإشعارات |
| `queue_entries` | إدارة الطابور الفعلي اليومي |

### Step 3 — بيانات تجريبية
- مدير افتراضي
- تخصصات: طب عام، أسنان، عيون، أطفال، جلدية
- أطباء مع جداول عمل

---

## Phase 2: المصادقة والصلاحيات

### Step 4 — تسجيل الدخول / التسجيل
- Email + Password مع bcrypt (12 rounds)
- express-session مع تخزين بـ SQLite
- توجيه تلقائي حسب الدور بعد الدخول

### Step 5 — Middleware للصلاحيات
- `requireAuth` — تحقق من الجلسة
- `requireRole(role)` — تحقق من الدور

---

## Phase 3: صفحات المريض

### Step 6 — لوحة المريض
- المواعيد القادمة
- موقعه في الطابور
- الإشعارات غير المقروءة

### Step 7 — حجز موعد (Smart Scheduling)
- اختيار تخصص → طبيب → اقتراح أقرب 5 مواعيد متاحة تلقائياً
- محرك الجدولة يحسب المواعيد المتاحة بناءً على جدول الطبيب والمواعيد المحجوزة

### Step 8 — مواعيدي
- عرض جميع المواعيد (قادمة، سابقة، ملغاة)
- إلغاء الموعد → إشعار أول مريض في قائمة الانتظار

### Step 9 — قائمة الانتظار
- الانضمام إذا لا يوجد موعد مناسب
- عند توفر موعد: إشعار تلقائي مع 30 دقيقة للتأكيد

### Step 10 — حالة الطابور
- الموقع الحالي + الوقت المتوقع للانتظار
- تحديث تلقائي كل 30 ثانية (Polling)
- التنبؤ بناءً على: position × avg_duration × delay_factor × (1 - no_show_rate)

### Step 11 — الإشعارات
- عرض جميع الإشعارات + تعليم كمقروء
- تأكيد/رفض عروض المواعيد المتاحة خلال 30 دقيقة
- تحديث تلقائي كل 60 ثانية (Polling)

---

## Phase 4: صفحات الطبيب

### Step 12 — لوحة الطبيب
- مواعيد اليوم مرتبة بالوقت
- الطابور الحالي مع أسماء المرضى
- إحصائيات سريعة: إجمالي اليوم، تم الكشف، المتبقي

### Step 13 — إدارة الطابور
- استدعاء المريض → بدء الكشف → اكتمال / لم يحضر
- تحديث تلقائي لمواقع المرضى المتبقين

### Step 14 — الجدول الأسبوعي
- عرض وتعديل ساعات العمل لكل يوم
- حظر أيام محددة (إجازات)

---

## Phase 5: صفحات المدير

### Step 15 — لوحة الإدارة
- إحصائيات: مواعيد اليوم، إلغاءات، عدم حضور، متوسط انتظار
- نظرة عامة على حالة كل الأطباء

### Step 16 — إدارة الأطباء (CRUD)
- إضافة/تعديل/حذف/تفعيل-تعطيل الأطباء

### Step 17 — إدارة المواعيد
- عرض بفلاتر (تاريخ، طبيب، حالة)
- إلغاء/إعادة جدولة نيابة عن المريض
- عرض قائمة الانتظار

### Step 18 — إدارة التخصصات (CRUD)

### Step 19 — التقارير
- إحصائيات يومية/أسبوعية: عدد المواعيد، متوسط الانتظار، نسبة عدم الحضور، نسبة الإلغاء
- أداء كل طبيب

---

## Phase 6: المحرك الذكي (Critical)

### Step 20 — `utils/scheduler.js`
| الوظيفة | الوصف |
|---|---|
| `getAvailableSlots(doctorId, fromDate, toDate, limit)` | إرجاع أقرب المواعيد المتاحة |
| `onCancellation(appointmentId)` | إشعار أول مريض في قائمة الانتظار |
| `processExpiredOffers()` | كل 5 دقائق: انتهاء العروض → إشعار المريض التالي |
| `suggestBestSlot(patientId, specialtyId)` | أقرب موعد عبر كل أطباء التخصص |

### Step 21 — `utils/queue-predictor.js`
| الوظيفة | الوصف |
|---|---|
| `getQueuePosition(patientId, doctorId, date)` | الموقع الحالي في الطابور |
| `estimateWaitTime(doctorId, position)` | position × avg_duration × delay_factor × (1 - no_show_rate) |
| `getHistoricalStats(doctorId, days)` | متوسط المدة، عامل التأخير، نسبة عدم الحضور |

---

## Phase 7: الواجهة والتصميم

### Step 22 — تصميم RTL عربي
- `dir="rtl"` + `lang="ar"`
- CSS متجاوب (mobile-friendly)
- خط Cairo/Tajawal من Google Fonts
- ألوان طبية: أزرق/أخضر/أبيض
- شريط جانبي حسب الدور
- شارات الحالة ملونة (أخضر=مؤكد، أصفر=انتظار، أحمر=ملغى)

### Step 23 — `public/js/polling.js`
- تحديث شارة الإشعارات (كل 60 ثانية)
- تحديث حالة الطابور (كل 30 ثانية)
- عداد تنازلي لصلاحية عرض الموعد

---

## Phase 8: الأمان والمهام الخلفية

### Step 24 — الأمان
- helmet.js للـ HTTP headers
- CSRF protection
- Parameterized queries (SQL injection prevention)
- Rate limiting على صفحة الدخول
- Input validation/sanitization
- Session security (httpOnly, sameSite)

### Step 25 — المهام الخلفية (`setInterval`)
- كل 5 دقائق: معالجة عروض قائمة الانتظار المنتهية
- كل دقيقة: تذكيرات المواعيد (قبل 30 دقيقة من الموعد)

---

## الملفات المطلوبة

| المسار | الوصف |
|---|---|
| `server.js` | نقطة الدخول + إعداد Express |
| `db/connection.js` | اتصال SQLite |
| `db/schema.sql` | إنشاء الجداول |
| `db/seed.sql` | بيانات تجريبية |
| `middleware/auth.js` | requireAuth, requireRole |
| `routes/auth.js` | تسجيل دخول/خروج/تسجيل |
| `routes/patient.js` | صفحات المريض |
| `routes/doctor.js` | صفحات الطبيب |
| `routes/admin.js` | صفحات المدير |
| `routes/api.js` | نقاط API للـ Polling |
| `utils/scheduler.js` | محرك الجدولة الذكية |
| `utils/queue-predictor.js` | تنبؤ الطابور |
| `utils/notifications.js` | إدارة الإشعارات |
| `views/layout.ejs` | القالب الرئيسي (RTL) |
| `public/css/style.css` | التنسيقات |
| `public/js/polling.js` | Polling للتحديثات |
| `public/js/app.js` | تفاعلات الواجهة |

---

## اختبارات التحقق
1. تسجيل مريض → دخول → حجز موعد → يظهر في "مواعيدي"
2. إلغاء موعد → مريض الانتظار يحصل على إشعار → تأكيد/رفض
3. الطبيب يعالج المرضى → تحديث مواقع الطابور
4. صفحة الطابور: الوقت المتوقع يتغير مع تقدم المرضى
5. المدير يضيف طبيب → المرضى يحجزون معه
6. Smart Scheduling: ملء يوم طبيب → إلغاء → إشعار مريض الانتظار
7. انتهاء صلاحية العرض → إشعار المريض التالي
8. تحقق من عرض RTL العربي
9. اختبار الأمان: دخول خاطئ، وصول غير مصرح → 403

---

## القرارات التقنية
| القرار | السبب |
|---|---|
| **Polling** بدل Socket.IO | كل 30-60 ثانية — أبسط وبدون تبعيات إضافية |
| **Server-rendered** بـ EJS | بدون SPA — أبسط وأسرع في التطوير |
| **SQLite** | ملف واحد بدون خادم قاعدة بيانات |
| **Rule-based prediction** | معادلة بسيطة بدون ML |
| **Session auth** | بدون JWT — جلسات على الخادم |
| **30 دقيقة صلاحية** | مدة تأكيد عرض الموعد لمريض الانتظار |
