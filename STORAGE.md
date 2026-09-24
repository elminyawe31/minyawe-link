# MINYAWE-LINK V2 — التخزين الكبير المجاني (مرتب)

## الترتيب من الأكبر للأصغر (مجاني)

| # | الخدمة | مساحة مجانية | ترافيك | S3؟ | محتاج فيزا؟ | تنفع لـ direct link؟ |
|---|--------|--------------|--------|-----|-------------|----------------------|
| 1 | **Storj DCS** | 25GB تخزين + 25GB تحميل شهريا | مجاني جوه الحد | ✅ S3-compatible | لا | ✅ ممتاز |
| 2 | **Cloudflare R2** | 10GB تخزين | تحميل مجاني غير محدود | ✅ S3-compatible | غالبا اه للتفعيل | ✅ ممتاز + دومين خاص |
| 3 | **Cloudinary** | ~25GB (credits) | معقول | ❌ API خاص | لا | ✅ ممتاز صور/فيديو فقط |
| 4 | **Backblaze B2** | 10GB | 1GB يوميا مجاني بعدها مدفوع | ✅ S3-compatible | لا | ✅ |
| 5 | **Railway Volume** | 500MB default (قابلة للزيادة مدفوعة) | مدفوع | ❌ local | لا | ✅ بس صغيرة |

## التوصية: Storj الأول (من غير فيزا) ثم R2

الكود V2 بيدعم أي S3 بنفس المتغيرات. اللي يتغير هو الـ Endpoint بس.

### A) Storj (25GB مجانا — الأكبر)
1. اعمل حساب على storj.io
2. Create Bucket مثلا `minyawe-link` وخليه Public
3. Access Keys -> Create S3 Credentials
4. في Railway Variables ضيف:
```
STORAGE_DRIVER=s3
S3_ENDPOINT=https://gateway.storjshare.io
S3_BUCKET=minyawe-link
S3_ACCESS_KEY=xxx
S3_SECRET_KEY=xxx
S3_REGION=us-east-1
S3_PUBLIC_URL=https://link.storjshare.io/s/jxxx/minyawe-link
MAX_FILE_SIZE_MB=200
```
ملحوظة: Storj بيديك Link Sharing لكل ملف، الـ PUBLIC_URL بتاخده من Share -> Public.

### B) Cloudflare R2 (10GB + تحميل لا نهائي)
1. Cloudflare Dashboard -> R2 -> Create Bucket `minyawe-link` -> Public + اربط دومين `cdn.xxx.com`
2. Manage API Tokens -> Create (Object Read & Write)
3. في Railway:
```
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_BUCKET=minyawe-link
S3_ACCESS_KEY=xxx
S3_SECRET_KEY=xxx
S3_REGION=auto
S3_PUBLIC_URL=https://cdn.xxx.com
```

### C) من غير أي حاجة (local)
سيب متغيرات S3 فاضية. هيخزن على Volume `/data` (500MB). مناسب للتجربة والصور الصغيرة.

## ملاحظات top4top (direct link)
- الكود بيبعت `Content-Disposition: inline` + `CORS: *` + `Accept-Ranges` عشان الأغاني والفيديو يشتغلوا جوه المتصفح والمشغلات.
- الممنوع بس: exe/scr/bat/ps1/msi/dll. الباقي كله مسموح (mp3/mp4/jpg/pdf/zip).
- لو عايز دائم خلي expiry = never أو 30d.
