# MINYAWE-LINK — التخزين الدائم المجاني (مرتب)

## ✅ الموصى به دلوقتي: Catbox (شغال علطول — من غير حساب ومن غير فيزا)
- **مساحة مفتوحة، ملفات لحد 200MB** (نفس حد الموقع بالظبط)
- **من غير حساب خالص ومن غير فيزا** — مفيش signup ومفيش مفاتيح
- لينكات مباشرة دايمة شكلها `https://files.catbox.moe/xxxxxx.mp3`
- الموقع بيستخدمه **لوحده تلقائيا** — مش محتاج تحط أي متغيرات جديدة
- ملحوظة واحدة بصراحة: catbox مفيهوش زرار مسح من عندهم، فملفاتك بتفضل عايشة عندهم حتى بعد ما مدتها تخلص عندنا (المسح بيشيلها من موقعك بس). لو دي مشكلة بالنسبالك استخدم Cloudinary تحت.

### التشغيل (دقيقة واحدة):
1. في Railway → Variables **امسح متغيرات Storj/S3 كلها** (`S3_*`)
2. اتأكد ان دول موجودين بس:
```
MAX_FILE_SIZE_MB=200
BASE_URL=https://minyawe-link-production.up.railway.app
```
3. متضيفش `STORAGE_DRIVER` خالص — الموقع هيختار catbox لوحده
4. Redeploy → افتح `/api/config` لازم يقول `storage: catbox` → ارفع وجرب

## البديل الاحترافي: Cloudinary (دائم + dashboard + مسح حقيقي)
- **25 credits شهريا ببلاش** (1GB تخزين = 1 credit، يعني ~25GB مشتركة تخزين+ترافيك)
- التسجيل **بالإيميل أو جوجل أو جيتهاب، من غير فيزا خالص**
- لينكات CDN **دايمة ومبتنتهيش** + تشغيل أغاني وفيديو مباشر بجودة عالية
- مناسب جدا لاستخدام top4top: صور + أغاني + فيديو (الفيديو الكبير لحد ~100MB على المجاني)

### الخطوات (5 دقايق):
1. اعمل حساب على **cloudinary.com** (Sign Up Free) وادخل الـ Dashboard
2. من الـ Dashboard انسخ: **Cloud name** + **API Key**
3. هات الـ **API Secret** من Dashboard (زرار reveal جنب الـ API Key) وانسخه
4. في Railway → Variables **امسح متغيرات Storj/S3 القديمة** وحط دول:
```
STORAGE_DRIVER=cloudinary
CLOUDINARY_CLOUD_NAME=xxx
CLOUDINARY_API_KEY=xxx
CLOUDINARY_API_SECRET=xxx
MAX_FILE_SIZE_MB=100
```
5. هيعمل Redeploy لوحده → افتح `/api/config` لازم يقول `storage: cloudinary` → ارفع أغنية وجرب اللينك اللي هيطلع من `res.cloudinary.com`

### ملحوظة الاستهلاك:
الموقع بيمسح الملفات المنتهية من Cloudinary لوحده (أقصى مدة شهر)، فالمساحة بتفضى أول بأول ومش هتخلص الـ 25GB بسهولة.

## البديل: Backblaze B2 (لو معاك فيزا بعدين)
- **10GB تخزين مجانا + 1GB تحميل يوميا مجانا**
- اللينكات العامة **دايمة ومبتنتهيش** (عكس Storj trial)
- التسجيل بالإيميل بس، **مش محتاج فيزا**
- S3-compatible يعني شغال مع كود الموقع من غير أي تغيير

### الخطوات (10 دقايق):
1. اعمل حساب على **backblaze.com** (B2 Cloud Storage) بالإيميل وفعّله
2. من القايمة: **Buckets → Create a Bucket**
   - اسم فريد مثلا: `minyawe-link` (لو متاخد جرّب `minyawe-link-31`)
   - **Files in Bucket are: Public** ← مهم عشان اللينك المباشر
   - باقي الاختيارات default ودوس Create
3. من صفحة الباكت انسخ حاجتين:
   - **Endpoint** وهيبقى شكله: `s3.us-east-005.backblazeb2.com` (الرقم يختلف عندك)
   - اسم الباكت اللي اخترته
4. من القايمة: **App Keys → Add a New Application Key**
   - Name: `minyawe-link`
   - Allow access to Bucket(s): اختار الباكت بتاعك
   - Type of Access: **Read and Write**
   - باقي الحاجات default ودوس Create
   - انسخ **keyID** و **applicationKey** فورا (السيكريت بيظهر مرة واحدة)
5. في Railway → Variables حط:
```
S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com
S3_BUCKET=minyawe-link
S3_ACCESS_KEY=keyID-بتاعك
S3_SECRET_KEY=applicationKey-بتاعك
S3_REGION=us-east-005
S3_PUBLIC_URL=https://f005.backblazeb2.com/file/minyawe-link
MAX_FILE_SIZE_MB=200
```
   - غيّر `005` و `us-east-005` حسب الـ Endpoint اللي طلعلك
   - القاعدة: `S3_PUBLIC_URL = https://fXXX.backblazeb2.com/file/BUCKET` بنفس رقم الـ Endpoint
6. هيعمل Redeploy لوحده → افتح `/api/config` لازم يقول `storage: s3:minyawe-link` → ارفع ملف وجرب اللينك

### لو حصل مشكلة S3 (نادرا):
ضيف متغير `S3_FORCE_PATH_STYLE=false` وهيعمل Redeploy ويجرب الطريقة التانية لوحده.

## الترتيب الكامل (لو حبيت تغيّر بعدين)

| # | الخدمة | مجاني | اللينك | فيزا؟ | ملاحظة |
|---|--------|-------|--------|-------|--------|
| 1 | **Backblaze B2** | 10GB + 1GB/يوم تحميل | دائم ✅ | لا ✅ | الاختيار الحالي |
| 2 | **Cloudflare R2** | 10GB + تحميل غير محدود | دائم ✅ | غالبا اه | أحسن لو معاك فيزا |
| 3 | **Storj** | 25GB | Trial بينتهي ⚠️ | لا | سيبناه بسبب الـ expiry |
| 4 | **Railway Volume** | 500MB | دائم ✅ | لا | صغير، للـ DB بس |

## ملاحظات top4top (direct link)
- الكود بيبعت `Content-Disposition: inline` + `CORS: *` + `Accept-Ranges` عشان الأغاني والفيديو يشتغلوا جوه المتصفح والمشغلات.
- الممنوع بس: exe/scr/bat/ps1/msi/dll. الباقي كله مسموح (mp3/mp4/jpg/pdf/zip).
- أقصى مدة احتفاظ: شهر (مفروضة من السيرفر نفسه).
