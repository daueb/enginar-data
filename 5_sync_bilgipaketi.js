require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// --- GÜVENLİK AYARI ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const BEARER_TOKEN = process.env.BILGIPAKETI_TOKEN;

if (!supabaseUrl || !supabaseKey) {
    throw new Error("❌ Hata: Supabase URL veya Key eksik!");
}
if (!BEARER_TOKEN) {
    throw new Error("❌ Hata: BILGIPAKETI_TOKEN eksik! bilgipaketi.cankaya.edu.tr'den Bearer token alıp .env'ye ekleyin.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// --- ANTI-DDOS: Rastgele gecikmeli delay ---
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));
function smartDelay(baseMs = 300) {
    // baseMs +/- %40 rastgele jitter (insan davranisi simulasyonu)
    const jitter = baseMs * 0.4 * (Math.random() * 2 - 1);
    return delay(Math.max(100, Math.round(baseMs + jitter)));
}

// Dakikalik istek sayaci (sunucu korumasi)
let requestCount = 0;
let minuteStart = Date.now();
const MAX_REQUESTS_PER_MINUTE = 120; // Dakikada max 120 istek

async function throttle() {
    requestCount++;
    const elapsed = Date.now() - minuteStart;
    if (elapsed >= 60000) {
        requestCount = 1;
        minuteStart = Date.now();
    } else if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
        const waitMs = 60000 - elapsed + 1000;
        console.log(`   ⏳ Rate limit: ${waitMs / 1000}sn bekleniyor...`);
        await delay(waitMs);
        requestCount = 1;
        minuteStart = Date.now();
    }
}

const API_BASE = 'https://ogbs.cankaya.edu.tr/Api/InformationPack';
const API_HEADERS = {
    'Authorization': `Bearer ${BEARER_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://bilgipaketi.cankaya.edu.tr/'
};

// --- API ÇAĞRI HELPER ---
async function apiGet(endpoint, params = {}) {
    await throttle();
    const url = `${API_BASE}/${endpoint}`;
    try {
        const res = await axios.get(url, { headers: API_HEADERS, params, timeout: 15000 });
        return res.data;
    } catch (err) {
        if (err.response?.status === 429) {
            console.log(`   ⏳ 429 Too Many Requests - 30sn bekleniyor...`);
            await delay(30000);
            return apiGet(endpoint, params); // Tekrar dene
        }
        console.error(`❌ API Hatası (${endpoint}):`, err.response?.status, err.response?.data || err.message);
        return null;
    }
}

// --- Bilgipaketi Program Listesi ---
// /Fakulteler ve /Bolumler endpointlerinden tum programlari cek
async function fetchProgramList() {
    const allPrograms = [];
    // L=Lisans, Y=Yuksek Lisans, D=Doktora
    for (const progType of ['L', 'Y', 'D']) {
        const fakulteler = await apiGet('Fakulteler', { Program: progType });
        if (!fakulteler || !Array.isArray(fakulteler)) continue;

        for (const fak of fakulteler) {
            const fakNo = fak.FakNo || fak.fakNo;
            if (!fakNo) continue;

            const bolumler = await apiGet('Bolumler', { Program: progType, FakNo: fakNo });
            if (!bolumler || !Array.isArray(bolumler)) continue;

            for (const b of bolumler) {
                allPrograms.push({
                    ProgramId: b.ProgramId || b.programId,
                    ProgramAdi: b.ProgramAdi || b.programAdi || '',
                    ProgramAdiEN: b.ProgramAdiEn || b.programAdiEn || '',
                    FakulteTR: fak.FakTurkce || '',
                    ProgramType: progType
                });
            }
            await smartDelay(300);
        }
    }
    return allPrograms;
}

// --- Supabase departments eşleştirme ---
async function getDepartmentMap() {
    const { data, error } = await supabase.from('departments').select('id, name, code');
    if (error) {
        console.error('❌ Departments okunamadı:', error.message);
        return {};
    }
    const map = {};
    for (const dept of data) {
        // İsme göre eşleştir (normalize edilmiş)
        const key = normalize(dept.name);
        map[key] = dept.id;
    }
    return map;
}

function normalize(str) {
    if (!str) return '';
    return str.toLowerCase()
        .replace(/ı/g, 'i').replace(/İ/g, 'i')
        .replace(/ö/g, 'o').replace(/ü/g, 'u')
        .replace(/ç/g, 'c').replace(/ş/g, 's')
        .replace(/ğ/g, 'g')
        .replace(/[^a-z0-9]/g, '');
}

// --- SAYFA ANAHTARLARI ---
const PAGE_KEYS = {
    0: 'bolum_tanitimi',
    1: 'kazanilan_derece',
    2: 'kabul_kosullari',
    3: 'onceki_ogrenme',
    4: 'yeterlilik_kosullari',
    5: 'programin_amaci',
    6: 'program_ciktilari',
    7: 'program_yeterlilikleri',
    8: 'mezunlarin_istihdam',
    9: 'ust_derece_programlara_gecis'
};

// =====================================================
// ANA SENKRONİZASYON
// =====================================================
(async () => {
    console.log('🔄 Bilgipaketi Senkronizasyonu Başlatılıyor...\n');

    const deptMap = await getDepartmentMap();
    console.log(`📋 ${Object.keys(deptMap).length} bölüm eşleştirildi.\n`);

    // 1. Program listesini al (/Fakulteler + /Bolumler endpointleri)
    const programs = await fetchProgramList();
    if (programs.length === 0) {
        console.log('❌ Hic program bulunamadi! API erisilemez olabilir.');
        return;
    }

    console.log(`📡 ${programs.length} program bulundu.\n`);

    // Tüm benzersiz BimKodu'ları topla (ders detayları için)
    // Her entry: { bimKodu, mufNo, bolumKodu }
    const allBimKodlari = [];
    const bimKodMap = new Map(); // bimKodu -> { mufNo, bolumKodu }

    for (const prog of programs) {
        const programId = prog.ProgramId || prog.programId;
        const programName = prog.ProgramAdi || prog.programAdi || prog.Ad || `Program ${programId}`;
        const programNameEN = prog.ProgramAdiEN || prog.programAdiEN || prog.AdEN || '';

        if (!programId) continue;

        console.log(`\n${'='.repeat(60)}`);
        console.log(`📚 İşleniyor: ${programName} (ID: ${programId})`);
        console.log('='.repeat(60));

        // Department eşleştir
        const deptId = findDepartment(deptMap, programName) || null;

        // --- A: Bölüm Bilgi Sayfaları (Sayfa 0-9) ---
        await syncProgramInfo(programId, deptId);
        await smartDelay(400);

        // --- B: Program Yeterlilikleri (Sayfa 7'den) ---
        await syncProgramQualifications(programId);
        await smartDelay(400);

        // --- C: Müfredatlar ---
        await syncCurricula(programId, programName, programNameEN, deptId, allBimKodlari, bimKodMap, prog.ProgramType);
        await smartDelay(500);
    }

    // 2. Ders Detayları (benzersiz BimKodu'lar) — 5'li paralel batch
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📖 Ders Detayları Senkronize Ediliyor (${allBimKodlari.length} ders)...`);
    console.log('='.repeat(60));

    const BATCH_SIZE = 5;
    let detailCount = 0;
    for (let i = 0; i < allBimKodlari.length; i += BATCH_SIZE) {
        const batch = allBimKodlari.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(entry =>
            syncCourseDetail(entry.bimKodu, entry.mufNo, entry.bolumKodu)
        ));
        detailCount += batch.length;
        if (detailCount % 50 < BATCH_SIZE) {
            console.log(`   ... ${detailCount}/${allBimKodlari.length} ders detayı işlendi`);
        }
        await smartDelay(200);
    }

    console.log(`\n🚀 Bilgipaketi Senkronizasyonu Tamamlandı!`);
    console.log(`   Toplam ${allBimKodlari.length} ders detayı işlendi.`);
})();

// =====================================================
// HELPER: Department Eşleştirme
// =====================================================
function findDepartment(deptMap, programName) {
    const normalized = normalize(programName);
    // Direkt eşleşme
    if (deptMap[normalized]) return deptMap[normalized];
    // Kısmi eşleşme
    for (const [key, id] of Object.entries(deptMap)) {
        if (normalized.includes(key) || key.includes(normalized)) return id;
    }
    return null;
}

// =====================================================
// A: Bölüm Bilgi Sayfaları
// =====================================================
async function syncProgramInfo(programId, deptId) {
    for (let sayfa = 0; sayfa <= 9; sayfa++) {
        const data = await apiGet('BolumBilgi', { ProgramId: programId, Sayfa: sayfa });
        if (!data) continue;

        const contentTr = extractText(data, 'tr');
        const contentEn = extractText(data, 'en');

        if (!contentTr && !contentEn) continue;

        const pageKey = PAGE_KEYS[sayfa] || `sayfa_${sayfa}`;

        const { error } = await supabase.from('program_info').upsert({
            program_id: programId,
            department_id: deptId,
            page_key: pageKey,
            content_tr: contentTr,
            content_en: contentEn
        }, { onConflict: 'program_id,page_key', ignoreDuplicates: false });

        if (error) {
            // upsert onConflict çalışmazsa insert dene
            await supabase.from('program_info').insert({
                program_id: programId,
                department_id: deptId,
                page_key: pageKey,
                content_tr: contentTr,
                content_en: contentEn
            });
        }

        await smartDelay(250);
    }
    console.log(`   ✅ Bölüm bilgi sayfaları kaydedildi`);
}

// HTML/JSON'dan temiz metin çıkar
function extractText(data, lang) {
    if (!data) return '';
    // API farklı formatlar döndürebilir
    if (typeof data === 'string') {
        return stripHtml(data);
    }
    if (lang === 'tr') {
        return stripHtml(data.Icerik || data.IcerikTR || data.icerik || data.icerikTr || data.Content || '');
    }
    return stripHtml(data.IcerikEN || data.icerikEN || data.icerikEn || data.ContentEN || '');
}

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// =====================================================
// B: Program Yeterlilikleri
// =====================================================
async function syncProgramQualifications(programId) {
    const data = await apiGet('BolumBilgi', { ProgramId: programId, Sayfa: 7 });
    if (!data) return;

    // Yeterlilikler genellikle liste halinde gelir
    const items = Array.isArray(data) ? data : (data.Liste || data.Items || data.list || []);

    if (!Array.isArray(items) || items.length === 0) return;

    // Önceki verileri temizle
    await supabase.from('program_qualifications').delete().eq('program_id', programId);

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        await supabase.from('program_qualifications').insert({
            program_id: programId,
            qualification_no: item.SiraNo || item.No || i + 1,
            content_tr: stripHtml(item.Aciklama || item.AciklamaTR || item.Icerik || item.icerik || ''),
            content_en: stripHtml(item.AciklamaEN || item.IcerikEN || '')
        });
    }
    console.log(`   ✅ ${items.length} program yeterliliği kaydedildi`);
}

// =====================================================
// C: Müfredatlar ve Müfredat Dersleri
// =====================================================
async function syncCurricula(programId, programName, programNameEN, deptId, allBimKodlari, bimKodMap, programType) {
    // Müfredat listesi (method:700 + Params gerekli, array of arrays döner)
    // Format: [[mufNo, bolumKodu, nameTR, nameEN, progType, year, ?, programId], ...]
    const mufredatlar = await apiGet('WsPersonel', { method: 700, methodNo: 11, Params: String(programId) });
    if (!mufredatlar || !Array.isArray(mufredatlar) || mufredatlar.length === 0) {
        console.log(`   ⚠️ Müfredat bulunamadı`);
        return;
    }

    for (const muf of mufredatlar) {
        // API array of arrays doner: [mufNo, bolumKodu, nameTR, nameEN, progType, year, ?, programId]
        const mufNo = Array.isArray(muf) ? muf[0] : (muf.MufredatNo || muf.mufredatNo || muf.Id);
        const bolumKodu = Array.isArray(muf) ? muf[1] : (muf.BolumKodu || muf.bolumKodu || 0);
        const mufYear = Array.isArray(muf) ? (muf[5] || new Date().getFullYear()) : (muf.Yil || muf.yil || new Date().getFullYear());
        const mufName = Array.isArray(muf) ? (muf[2] || programName) : (muf.Ad || muf.MufredatAdi || programName);
        const mufNameEN = Array.isArray(muf) ? (muf[3] || programNameEN) : programNameEN;
        // Program tipi kodu: frontend'de sabit "3" kullanıyor ama müfredat array'inden de gelebilir
        const progTypeCode = Array.isArray(muf) ? (muf[4] || '3') : '3';

        if (!mufNo) continue;

        // curricula tablosuna kaydet
        const { data: currData, error: currErr } = await supabase.from('curricula').upsert({
            program_id: programId,
            department_id: deptId,
            name: mufName,
            name_en: programNameEN,
            year: mufYear,
            muf_no: mufNo
        }, { onConflict: 'program_id,muf_no', ignoreDuplicates: false }).select('id').single();

        let curriculumId = currData?.id;

        if (currErr || !curriculumId) {
            // Fallback: ara
            const { data: existing } = await supabase.from('curricula')
                .select('id')
                .eq('program_id', programId)
                .eq('muf_no', mufNo)
                .maybeSingle();
            curriculumId = existing?.id;

            if (!curriculumId) {
                const { data: inserted } = await supabase.from('curricula').insert({
                    program_id: programId,
                    department_id: deptId,
                    name: mufName,
                    name_en: programNameEN,
                    year: mufYear,
                    muf_no: mufNo
                }).select('id').single();
                curriculumId = inserted?.id;
            }
        }

        if (!curriculumId) {
            console.log(`   ❌ Müfredat kaydedilemedi: ${mufName}`);
            continue;
        }

        // Müfredattaki dersler (method:700, Params: "progTypeCode;programId;mufNo")
        // Frontend JS bundle'dan: const e = `3;${this.id};${this.selectedCurriculum}`
        const dersler = await apiGet('WsPersonel', { method: 700, methodNo: 14, Params: `${progTypeCode};${programId};${mufNo}` });
        if (!dersler || !Array.isArray(dersler) || dersler.length === 0) {
            console.log(`   ⚠️ Müfredat dersleri alinamadi (MufNo: ${mufNo}) - API hatasi olabilir`);
            continue;
        }

        // Eski dersleri temizle
        await supabase.from('curriculum_courses').delete().eq('curriculum_id', curriculumId);

        let courseCount = 0;
        for (const ders of dersler) {
            // API array of arrays veya object donebilir
            // Gercek format (methodNo=14): ["mufNo","siraNo","bimKodu","sinif","donem","dersKodPrefix","dersNo","dersAdiTR","dersAdiEN","?","teorik","uygulama","kredi","akts","secmeli","?"]
            let bimKodu, courseCode, courseName, courseNameEN, sinif, donem, teorik, uygulama, kredi, akts, secmeli;
            if (Array.isArray(ders)) {
                // Array format: [mufNo, siraNo, bimKodu, sinif, donem, dersKodPrefix, dersNo, adTR, adEN, ?, teorik, uygulama, kredi, akts, secmeli, ?]
                bimKodu = ders[2];
                const prefix = (ders[5] || '').trim();
                const no = ders[6] || '';
                courseCode = prefix ? `${prefix} ${no}`.trim() : '';
                courseName = ders[7] || '';
                courseNameEN = ders[8] || '';
                sinif = ders[3]; donem = ders[4];
                teorik = ders[10]; uygulama = ders[11]; kredi = ders[12];
                akts = ders[13]; secmeli = ders[14];
            } else {
                bimKodu = ders.BimKodu || ders.bimKodu;
                courseCode = ders.DersKodu || ders.dersKodu || '';
                courseName = ders.DersAdi || ders.dersAdi || '';
                courseNameEN = ders.DersAdiEN || ders.dersAdiEN || '';
                sinif = ders.Sinif || ders.sinif || ders.Yil;
                donem = ders.Donem || ders.donem;
                teorik = ders.Teorik || ders.teorik;
                uygulama = ders.Uygulama || ders.uygulama || ders.Lab;
                kredi = ders.Kredi || ders.kredi;
                akts = ders.AKTS || ders.akts || ders.Ects;
                secmeli = ders.Secmeli || ders.secmeli || ders.IsElective;
            }

            // Mevcut courses tablosuyla eslestir
            let courseId = null;
            if (courseCode) {
                const { data: courseMatch } = await supabase.from('courses')
                    .select('id')
                    .eq('course_code', courseCode)
                    .maybeSingle();
                courseId = courseMatch?.id || null;
            }

            await supabase.from('curriculum_courses').insert({
                curriculum_id: curriculumId,
                course_id: courseId,
                bim_kodu: bimKodu || null,
                year: sinif || null,
                semester: donem || null,
                course_code: courseCode,
                course_name: courseName,
                course_name_en: courseNameEN,
                theory_hours: teorik || null,
                lab_hours: uygulama || null,
                credit: kredi || null,
                ects: akts || null,
                is_elective: !!secmeli
            });

            if (bimKodu && !bimKodMap.has(Number(bimKodu))) {
                bimKodMap.set(Number(bimKodu), { mufNo: Number(mufNo), bolumKodu: Number(bolumKodu) });
                allBimKodlari.push({ bimKodu: Number(bimKodu), mufNo: Number(mufNo), bolumKodu: Number(bolumKodu) });
            }
            courseCount++;
        }

        console.log(`   ✅ Müfredat "${mufName}" -> ${courseCount} ders kaydedildi`);
        await smartDelay(500);
    }
}

// =====================================================
// D: Ders Detayları
// =====================================================
async function syncCourseDetail(bimKodu, mufNo, bolumKodu) {
    // DersBilgi dogru parametreler: BimKodu + MufredatNo + BolumKodu + lang (JS bundle'dan)
    const data = await apiGet('DersBilgi', { BimKodu: bimKodu, MufredatNo: mufNo, BolumKodu: bolumKodu, lang: 'tr' });
    if (!data) return;

    // Ana ders bilgisi (API field isimleri: BimKodu, DersKod, DersNo, DersAdi, Teori, Pratik, Kredi, ECTSKredi, DersTanimi, DersWebSayfa, vb.)
    const dersKod = ((data.DersKod || data.dersKod || '') + ' ' + (data.DersNo || data.dersNo || '')).trim();
    const detail = {
        bim_kodu: bimKodu,
        course_code: dersKod,
        course_name: data.DersAdi || data.dersAdi || data.DersAdiTurkce || '',
        course_name_en: data.DersAdiEN || data.dersAdiEN || data.DersAdiEng || '',
        language: data.DersDili || data.dersDili || data.DersDilAd || '',
        level: data.DersSeviyesi || data.DersDuzeyi || data.dersDuzeyi || '',
        type: data.DersTuru || data.dersTuru || data.DersTipAd || '',
        delivery: data.DersVerilisBicimi || data.DersVerilis || data.dersVerilis || '',
        theory_hours: data.Teori || data.Teorik || data.teorik || null,
        lab_hours: data.Pratik || data.Uygulama || data.uygulama || null,
        credit: data.Kredi || data.kredi || null,
        ects: data.ECTSKredi || data.AKTS || data.akts || null,
        description: stripHtml(data.DersTanimi || data.dersTanimi || data.Tanim || ''),
        teaching_methods: stripHtml(data.OgretmeYontemleri || data.ogretmeYontemleri || ''),
        textbook: stripHtml(data.DersKaynaklar || data.dersKaynaklar || data.Textbook || ''),
        other_resources: stripHtml(data.DigerKaynaklar || data.digerKaynaklar || ''),
        prerequisites: data.Prequisites || data.OnKosul || data.onKosul || '',
        corequisites: data.Corequisites || data.EsKosul || data.esKosul || '',
        web_page: data.DersWebSayfa || data.WebSayfasi || data.webSayfasi || null
    };

    // Upsert ders detayı
    const { data: detailData, error: detailErr } = await supabase
        .from('course_details')
        .upsert(detail, { onConflict: 'bim_kodu' })
        .select('id')
        .single();

    let detailId = detailData?.id;
    if (detailErr || !detailId) {
        const { data: existing } = await supabase.from('course_details')
            .select('id')
            .eq('bim_kodu', bimKodu)
            .maybeSingle();
        detailId = existing?.id;
    }

    if (!detailId) return;

    // Haftalik konular (API field: CourseSubjets)
    const topics = data.CourseSubjets || data.HaftalikKonular || [];
    if (Array.isArray(topics) && topics.length > 0) {
        await supabase.from('course_weekly_topics').delete().eq('course_detail_id', detailId);
        for (const topic of topics) {
            await supabase.from('course_weekly_topics').insert({
                course_detail_id: detailId,
                week: topic.Hafta || topic.hafta || topic.Week || 0,
                topic: stripHtml(topic.Konu || topic.konu || topic.Topic || '')
            });
        }
    }

    // Ders kazanimlari (API field: CourseOutcomes)
    const outcomes = data.CourseOutcomes || data.DersKazanimlari || [];
    if (Array.isArray(outcomes) && outcomes.length > 0) {
        await supabase.from('course_outcomes').delete().eq('course_detail_id', detailId);
        for (const outcome of outcomes) {
            await supabase.from('course_outcomes').insert({
                course_detail_id: detailId,
                outcome_no: outcome.KazanimId || outcome.SiraNo || 0,
                outcome: stripHtml(outcome.Kazanim || outcome.kazanim || outcome.Outcome || '')
            });
        }
    }

    // Degerlendirme kriterleri (API field: CourseEvaluations)
    const evals = data.CourseEvaluations || data.DegerlendirmeKriterleri || [];
    if (Array.isArray(evals) && evals.length > 0) {
        await supabase.from('course_evaluations').delete().eq('course_detail_id', detailId);
        for (const ev of evals) {
            await supabase.from('course_evaluations').insert({
                course_detail_id: detailId,
                eval_type: ev.DegerlendirmeTuru || ev.Tur || ev.Type || ev.Ad || '',
                weight_percent: ev.Oran || ev.oran || ev.Weight || ev.Yuzde || null,
                count: ev.Sayi || ev.sayi || ev.Count || ev.Adet || null
            });
        }
    }
}
