# MINYAWE-LINK by ELMINYAWE 💜

خزنة ملفات بستايل Evervault: ارفع صور / أغاني / فيديو / أي ملف وخد **3 لينكات باسمك** (صفحة عرض + تشغيل مباشر + تحميل) — من غير حساب ومن غير فيزا.

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

## الـ API
| الطريقة | المسار | الوصف |
|---|---|---|
| POST | `/api/upload` | رفع (`file` + `expiry` + `alias` الاختياري) |
| POST | `/api/album` | ألبوم لحد 10 ملفات (`files`) في صفحة `/a/:id` |
| GET | `/api/stats` | لوحة الأرقام: ملفات/مشاهدات/مساحة/الأعلى |
| GET | `/v/:id` | صفحة العرض |
| GET | `/e/:id` | تشغيل مباشر (inline + Range) |
| GET | `/d/:id` | تحميل مباشر (attachment) |
| GET | `/i/:id` | لينك مختصر |
| DELETE | `/api/:id?token=` | مسح |
| GET | `/api/config` | الحدود + السلسلة + المساحة |
| GET | `/api/docs` | توثيق آلي JSON |
| GET | `/llms.txt` | تعريف للـ AI agents |
| GET | `/health` | فحص الحياة |

التفاصيل الكاملة للتخزين في `STORAGE.md`.
