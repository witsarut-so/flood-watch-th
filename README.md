# Flood Watch

แผนที่ติดตามน้ำท่วมสำหรับประชาชน รวมรายงานประชาชน (Traffy Fondue) โซเชียล (Bluesky) ข่าว เซนเซอร์และข้อมูลหน่วยงาน (ThaiWater) และแบบจำลองน้ำขังจากฝนของ 10 จังหวัด ไว้บนแผนที่เดียว พร้อมตัวกรองบนแผนที่

ไม่ใช่ระบบเตือนภัยทางการ แต่ละจุดแสดงเวลาและแหล่งที่มาของตัวเอง ไม่นำข้อมูลต่างแหล่งมาเฉลี่ยหรือเดาแทนกัน

## โครงสร้าง
เว็บเป็นไฟล์ static ทั้งหมด (โฮสต์บน Vercel) งานคำนวณรันบน GitHub Actions แล้ว deploy ผลขึ้น Vercel:

| งาน | รอบ | ผลลัพธ์ |
|---|---|---|
| หลักฐาน `node jobs.mjs evidence` ([evidence.yml](.github/workflows/evidence.yml)) | 30 นาที | `public/live/evidence.json`, `waterlevels.json` |
| แบบจำลอง `node jobs.mjs model --force` ([model.yml](.github/workflows/model.yml)) | 2 ชั่วโมง (~10 นาที/รอบ) | `public/live/model/latest.json`, `<runId>/<domain>-s<k>-f<i>.bin.gz` |
| ข้อมูลเตรียมไว้ `npm run prepare-data` | ครั้งเดียว/เมื่อต้องการอัปเดต OSM | `data/…`, `public/data/…` (อัปโหลดเป็น release asset `data-v1`) |

## เริ่มใช้งานบนเครื่อง
ต้องมี Node.js 22+ และ Python 3.11+

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-model.txt
npm run prepare-data     # DEM + ขอบเขตจังหวัด, gazetteer, OSM (137 tiles, ~1–2 ชม.), สร้าง public/data
npm start                # http://localhost:3000 และรันงานหลักฐาน/แบบจำลองตามรอบ
npm test && npm run check
```

## แบบจำลอง
พื้นที่ใน [model/domains.json](model/domains.json): ลุ่มเจ้าพระยาตอนล่าง (กรุงเทพฯ นนทบุรี ปทุมธานี อยุธยา สมุทรปราการ นครปฐม) • สระบุรี–นครนายก • ชลบุรี (กริด 100 ม.) • กาญจนบุรี (250 ม.)

ฝนรายชั่วโมงย้อนหลังสูงสุด 24 ชม. จากสถานี ThaiWater สูงสุด 16 สถานีต่อพื้นที่ (สถานีที่ขาดช่วงถูกตัด ไม่เติมศูนย์) → การไหลบนผิว 2 มิติ (Manning diffusive, จำกัดปริมาตรต่อเซลล์, ขอบพื้นที่ปล่อยน้ำออกได้) คำนวณด้วย numba ขั้นเวลา 15 วินาที (250 ม.: 30 วินาที; ทดสอบเทียบ 5 วินาทีแล้วต่างกัน p99 0.05 ซม.) • 3 สมมติฐานการระบาย 0/3/8 มม./ชม. • ตรวจสมดุลน้ำทุกรอบ • เทียบกับรายงานประชาชนและเซนเซอร์ (hit rate เทียบโอกาสสุ่ม และ false alarm จากเซนเซอร์ที่วัดได้ 0) ใช้ตรวจสอบเท่านั้น

ข้อจำกัด: ภูมิประเทศเป็น DSM ไม่ใช่ DTM • ไม่มีคลอง ท่อ ปั๊ม ประตูน้ำ ระดับแม่น้ำ การปล่อยน้ำเขื่อน หรือน้ำหลากจากต้นน้ำ (สำคัญในกาญจนบุรี สระบุรี นครนายก) • ถนนทุกเส้นในเซลล์เดียวกันได้สีเดียวกัน • บ่อ/หุบลึกใน DSM ทำให้ความลึกสูงสุดเกินจริงได้

## หลักฐานและการประมวลผลข้อความ
- **รายงานประชาชน**: Traffy Fondue 24 ชม. คัดเรื่องน้ำท่วม ลบเบอร์โทร/อีเมล ถ้า API ล่มใช้ข้อมูลรอบก่อนพร้อมเวลา
- **โซเชียล**: Bluesky public search (ไม่ต้องใช้ key) • X, Facebook, Instagram, TikTok ไม่มี API ค้นหาสาธารณะ จึงไม่ดึงโดยตรงและไม่ scrape
- **ข่าว**: RSS มติชน ข่าวสด ประชาชาติ ไทยรัฐ เดลินิวส์ Bangkok Post และ Google News 72 ชม. อ่านหน้าข่าวของสำนักโดยตรงสูงสุด 40 ข่าว/รอบ
- **หน่วยงาน (ThaiWater)**: เซนเซอร์น้ำท่วมถนนและอัตราการไหลในคลอง (สำนักการระบายน้ำ กทม.), ระดับน้ำคลอง, ประตูระบายน้ำ/ฝาย, ฝนรายชั่วโมงทุกสถานี (วาดเป็นพื้นผิวความเข้มฝน), ฝน 24 ชม., เขื่อน (กรมชลประทาน), ระดับน้ำแม่น้ำ • อัตราการสูบของสถานีสูบน้ำยังไม่มีข้อมูลสาธารณะ
- **สถานที่ในข้อความ** ([evidence-text.mjs](evidence-text.mjs), [named-match.mjs](named-match.mjs)): จังหวัด/อำเภอ/ตำบลจาก gazetteer OSM • ถนน ซอย หมู่บ้าน คลอง สะพาน แยก จาก OSM (`data/named`) จับคู่เมื่อบริบทชัด (พิกัดของรายงาน จังหวัด/อำเภอที่ระบุ หรือชื่อไม่ซ้ำ) ถนนยาวตัดเฉพาะช่วงใกล้พื้นที่ ชื่อที่ซ้ำหลายพื้นที่แสดงในรายการแต่ไม่วาด • ความลึก (ตัวเลข หรือ "ระดับเข่า" = ประมาณ) • ตัวเลขสำคัญ

## Deploy (Vercel + GitHub Actions)
Vercel ผูกกับ repo นี้ (Git integration) และ build ด้วย [scripts/vercel-build.mjs](scripts/vercel-build.mjs) ตาม [vercel.json](vercel.json): ดาวน์โหลดข้อมูลที่ไม่ได้อยู่ใน git จาก GitHub Releases แล้วเสิร์ฟ `public/`
- release `data-v1` / `prepared-data.tar.gz`: ข้อมูลเตรียมไว้ (`data/…`, `public/data/…`) สร้างใหม่ด้วย `npm run prepare-data` แล้ว `tar czf prepared-data.tar.gz data/domains data/boundary data/gazetteer data/named public/data`
- release `live` / `live.tar.gz`: ผลหลักฐานและแบบจำลองล่าสุด GitHub Actions อัปโหลดทับทุกรอบ ([scripts/publish-live.sh](scripts/publish-live.sh)) แล้วเรียก Vercel Deploy Hook

ตั้งค่าครั้งเดียว: สร้าง Deploy Hook ใน Vercel (Project → Settings → Git → Deploy Hooks, branch `main`) แล้วเก็บเป็น secret `VERCEL_DEPLOY_HOOK` ของ repo ไม่ต้องใช้ Vercel token รวมประมาณ 60 builds/วัน

### Thai relay (แหล่งที่เข้าได้จากในไทยเท่านั้น)
`now.bangkok.go.th` (ถนนน้ำท่วมทางการ กทม.) ไม่ตอบเซิร์ฟเวอร์ GitHub ในต่างประเทศ จึงให้เครื่องในไทยรัน `node jobs.mjs thai` (ดึง กทม. + Traffy) แล้วอัปโหลด `thai.json.gz` ขึ้น release `live` workflow ดาวน์โหลดไปใช้เมื่ออายุไม่เกิน 60 นาที ถ้าเกินจะแสดงเป็น "ข้อมูลรอบก่อน" พร้อมเวลา
- macOS: `scripts/thai-relay.sh install` (launchd รันนาที :20 และ :50), `status`, `run`, `uninstall` • log: `~/Library/Logs/floodwatch-thai-relay.log`
- ต้องมี `gh` ที่ล็อกอินบัญชีที่มีสิทธิ์เขียน repo (ตั้งด้วย `RELAY_GH_USER`, ค่าเริ่มต้น witsarut-so)
- ปิดเครื่อง: ข้อมูล กทม./Traffy ค้างที่รอบล่าสุด ส่วนอื่นยังอัปเดตตามปกติ

ก่อนเปิดใช้งานมาก ๆ: เปลี่ยน tile แผนที่ฐานใน [public/app.js](public/app.js) (tile.openstreetmap.org ห้ามใช้กับเว็บผู้ใช้มาก [นโยบาย](https://operations.osmfoundation.org/policies/tiles/)) และตรวจเงื่อนไขการเผยแพร่ข้อมูล Traffy Fondue, ThaiWater, Google News

## Attribution
แผนที่ ถนน ทางน้ำ ขอบเขต: © OpenStreetMap contributors (ODbL) • ภูมิประเทศ: Copernicus DEM GLO-30 © DLR e.V. 2010–2014 และ © Airbus Defence and Space GmbH 2014–2018, ESA Copernicus • ข้อมูลน้ำ: ThaiWater • รายงานประชาชน: Traffy Fondue / กรุงเทพมหานคร • โซเชียล: Bluesky
