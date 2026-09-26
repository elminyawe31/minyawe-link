# MINYAWE-LINK by ELMINYAWE 💜

خزنة ملفات بستايل Evervault: ارفع صور / أغاني / فيديو / أي ملف وخد **3 لينكات باسمك** (صفحة عرض + تشغيل مباشر + تحميل) — من غير حساب ومن غير فيزا.

## المزايا (v6.4)
- **رفع متعدد**: لحد 10 ملفات دفعة واحدة — كل ملف بشريط تقدم ولينكات خاصة (من الواجهة أو `curl` متكرر على `/api/upload`)
- **باسورد لكل ملف**: حقل `password` عند الرفع (min 3 حروف) أو تعيين/إزالة لاحقًا من لوحة الأدمن — يتخزن مشفر (scrypt) والفتح عبر `?pw=`
- **انتهاء تلقائي فعلي**: تنظيف كل 5 دقائق + مسح فوري عند الفتح (410) — الملف يتمسح من القرص (تخزين `local`) ويتسجل في السجل
- **لوحة أدمن**: بحث في الملفات + قفل/حذف + نسخ احتياطي ZIP + سجل عمليات (IP + وقت)
- **ثيم فاتح/داكن** بزر من الـ nav (محفوظ في المتصفح) + تجاوب كامل (موبايل/تابلت/لابتوب)
- سحب وإفلات + لصق `Ctrl+V` + QR + ألبومات + API و `llms.txt` للـ AI agents

## التشغيل على Railway (5 دقايق)
1. ارفع الملفات دي على ريبو GitHub
2. Railway → New Project → Deploy from GitHub repo
3. أضف Volume بـ Mount Path: `/data`
4. أضف Variables:
```
ADMIN_TOKEN=باسورد_من_عندك
MAX_FILE_SIZE_MB=200
BASE_URL=https://<your-domain>.up.railway.app
DATA_DIR=/data
```
5. Networking → Generate Domain → حط الدومين في `BASE_URL` واعمل Redeploy
6. اتأكد: `/health` تقول `MINYAWE-LINK OK` و`/api/config` تقول `storage: catbox`

## متغيرات اختيارية
| المتغير | معناه | الافتراضي |
|---|---|---|
| `STORAGE_DRIVER` | `catbox` أو `local` لفرض تخزين واحد | تلقائي: catbox ثم local |
| `STORAGE_ORDER` | ترتيب المحاولة مثلا `local,catbox` | `catbox,local` |
| `MAX_FILE_SIZE_MB` | أقصى حجم ملف | `200` |
| `RATE_MAX` | أقصى طلبات لكل IP كل 10 دقائق (الرفع المتعدد يستهلك طلبًا لكل ملف) | `60` |

## الـ API
| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/upload` | رفع (`file` + `expiry` + `alias` + `password` الاختياري) — يرجع `locked` |
| POST | `/api/album` | ألبوم لحد 10 ملفات (`files`) في صفحة `/a/:id` (بدون باسورد) |
| GET | `/api/stats` | لوحة الأرقام: ملفات/مشاهدات/مساحة/الأعلى |
| GET | `/v/:id` | صفحة العرض (نموذج فتح لو الملف مقفول — `?pw=`) |
| GET | `/e/:id` | تشغيل مباشر (inline + Range) — المقفول يحتاج `?pw=` |
| GET | `/d/:id` | تحميل مباشر (attachment) — المقفول يحتاج `?pw=` |
| GET | `/i/:id` | لينك مختصر — المقفول يحتاج `?pw=` |
| DELETE | `/api/:id?token=` | مسح |
| GET | `/api/config` | الحدود + السلسلة + المساحة |
| GET | `/api/docs` | توثيق آلي JSON |
| GET | `/llms.txt` | تعريف للـ AI agents |
| GET | `/health` | فحص الحياة |

## إدارة الأدمن (هيدر `x-admin-token` أو `?admin=TOKEN`)
| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/:id/password` | تعيين/تغيير الباسورد `{password}` — فاضي `""` للإزالة |
| GET | `/api/admin/files?q=` | كل الملفات + بحث (اسم/رابط/ID) |
| GET | `/api/admin/audit?q=&limit=` | سجل العمليات (رفع/مسح/انتهاء/باسورد/نسخ) مع IP والوقت |
| GET | `/api/admin/backup` | تحميل ZIP: `db.json` + `audit.log` + `uploads/` + `server.js` |

> ملحوظة: ملفات `catbox` لا يمكن مسحها عن بُعد — المسح/الانتهاء يشيلها من الفهرس فقط. المسح الفعلي من القرص ينطبق على تخزين `local` (`STORAGE_DRIVER=local`).

التفاصيل الكاملة للتخزين في `STORAGE.md`.
