require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// --- GÜVENLİK AYARI ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const BEARER_TOKEN = process.env.BILGIPAKETI_TOKEN;

if (!supabaseUrl || !supabaseKey) {
    throw new Error("❌ Hata: Supabase URL veya Key eksik!");
}
if (!BEARER_TOKEN) {
    throw new Error("❌ Hata: BILGIPAKETI_TOKEN eksik! bilgipaketi.cankaya.edu.tr'den Bearer token alıp .env'ye ekleyin.");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

const API_BASE = 'https://ogbs.cankaya.edu.tr/Api/InformationPack';
const headers = { 'Authorization': `Bearer ${BEARER_TOKEN}` };

// --- API ÇAĞRI HELPER ---
async function apiGet(endpoint, params = {}) {
    const url = `${API_BASE}/${endpoint}`;
    try {
        const res = await axios.get(url, { headers, params });
        return res.data;
    } catch (err) {
        console.error(`❌ API Hatası (${endpoint}):`, err.response?.status, err.response?.data || err.message);
        return null;
    }
}

// --- Bilgipaketi Program Listesi ---
// Program ID'leri bilgipaketi frontend'den alınır
// Bu mapping'i bilgipaketi ana sayfasındaki dropdown'dan çekiyoruz
async function fetchProgramList() {
    // WsPersonel methodNo=1 tüm fakülte/bölüm listesini döndürür
    const data = await apiGet('WsPersonel', { methodNo: 1 });
    if (!data) {
        console.error('❌ Program listesi alınamadı!');
        return [];
    }
    // API bir dizi döndürür, her eleman { ProgramId, ProgramAdi, ProgramAdiEN, ... }
    return Array.isArray(data) ? data : [];
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

    // 1. Program listesini al
    const programs = await fetchProgramList();
    if (programs.length === 0) {
        console.log('⚠️ Program listesi boş. methodNo=1 çalışmadıysa, sabit listeyi dene.');
        // Fallback: bilinen program ID'leri
        console.log('❌ Çıkılıyor.');
        return;
    }

    console.log(`📡 ${programs.length} program bulundu.\n`);

    // Tüm benzersiz BimKodu'ları topla (ders detayları için)
    const allBimKodlari = new Set();

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
        await delay(200);

        // --- B: Program Yeterlilikleri (Sayfa 7'den) ---
        await syncProgramQualifications(programId);
        await delay(200);

        // --- C: Müfredatlar ---
        await syncCurricula(programId, programName, programNameEN, deptId, allBimKodlari);
        await delay(200);
    }

    // 2. Ders Detayları (benzersiz BimKodu'lar)
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📖 Ders Detayları Senkronize Ediliyor (${allBimKodlari.size} ders)...`);
    console.log('='.repeat(60));

    let detailCount = 0;
    for (const bimKodu of allBimKodlari) {
        await syncCourseDetail(bimKodu);
        detailCount++;
        if (detailCount % 50 === 0) {
            console.log(`   ... ${detailCount}/${allBimKodlari.size} ders detayı işlendi`);
        }
        await delay(200);
    }

    console.log(`\n🚀 Bilgipaketi Senkronizasyonu Tamamlandı!`);
    console.log(`   Toplam ${allBimKodlari.size} ders detayı işlendi.`);
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

        await delay(100);
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
async function syncCurricula(programId, programName, programNameEN, deptId, allBimKodlari) {
    // Müfredat listesi
    const mufredatlar = await apiGet('WsPersonel', { methodNo: 11, ProgramId: programId });
    if (!mufredatlar || !Array.isArray(mufredatlar) || mufredatlar.length === 0) {
        console.log(`   ⚠️ Müfredat bulunamadı`);
        return;
    }

    for (const muf of mufredatlar) {
        const mufNo = muf.MufredatNo || muf.mufredatNo || muf.Id;
        const mufYear = muf.Yil || muf.yil || muf.Year || new Date().getFullYear();
        const mufName = muf.Ad || muf.MufredatAdi || programName;

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

        // Müfredattaki dersler
        const dersler = await apiGet('WsPersonel', { methodNo: 14, ProgramId: programId, MufredatNo: mufNo });
        if (!dersler || !Array.isArray(dersler)) {
            console.log(`   ⚠️ Müfredat dersleri bulunamadı (MufNo: ${mufNo})`);
            continue;
        }

        // Eski dersleri temizle
        await supabase.from('curriculum_courses').delete().eq('curriculum_id', curriculumId);

        let courseCount = 0;
        for (const ders of dersler) {
            const bimKodu = ders.BimKodu || ders.bimKodu;
            const courseCode = ders.DersKodu || ders.dersKodu || '';
            const courseName = ders.DersAdi || ders.dersAdi || '';
            const courseNameEN = ders.DersAdiEN || ders.dersAdiEN || '';

            // Mevcut courses tablosuyla eşleştir
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
                year: ders.Sinif || ders.sinif || ders.Yil || null,
                semester: ders.Donem || ders.donem || null,
                course_code: courseCode,
                course_name: courseName,
                course_name_en: courseNameEN,
                theory_hours: ders.Teorik || ders.teorik || null,
                lab_hours: ders.Uygulama || ders.uygulama || ders.Lab || null,
                credit: ders.Kredi || ders.kredi || null,
                ects: ders.AKTS || ders.akts || ders.Ects || null,
                is_elective: !!(ders.Secmeli || ders.secmeli || ders.IsElective)
            });

            if (bimKodu) allBimKodlari.add(bimKodu);
            courseCount++;
        }

        console.log(`   ✅ Müfredat "${mufName}" -> ${courseCount} ders kaydedildi`);
        await delay(200);
    }
}

// =====================================================
// D: Ders Detayları
// =====================================================
async function syncCourseDetail(bimKodu) {
    const data = await apiGet('DersBilgi', { BimKodu: bimKodu });
    if (!data) return;

    // Ana ders bilgisi
    const detail = {
        bim_kodu: bimKodu,
        course_code: data.DersKodu || data.dersKodu || '',
        course_name: data.DersAdi || data.dersAdi || '',
        course_name_en: data.DersAdiEN || data.dersAdiEN || '',
        language: data.DersDili || data.dersDili || '',
        level: data.DersDuzeyi || data.dersDuzeyi || '',
        type: data.DersTuru || data.dersTuru || '',
        delivery: data.DersVerilis || data.dersVerilis || '',
        theory_hours: data.Teorik || data.teorik || null,
        lab_hours: data.Uygulama || data.uygulama || null,
        credit: data.Kredi || data.kredi || null,
        ects: data.AKTS || data.akts || null,
        description: stripHtml(data.DersTanimi || data.dersTanimi || data.Tanim || ''),
        teaching_methods: stripHtml(data.OgretmeYontemleri || data.ogretmeYontemleri || ''),
        textbook: stripHtml(data.DersKaynaklar || data.dersKaynaklar || data.Textbook || ''),
        other_resources: stripHtml(data.DigerKaynaklar || data.digerKaynaklar || ''),
        prerequisites: data.OnKosul || data.onKosul || '',
        corequisites: data.EsKosul || data.esKosul || '',
        web_page: data.WebSayfasi || data.webSayfasi || null
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

    // Haftalık konular
    const topics = data.HaftalikKonular || data.haftalikKonular || data.WeeklyTopics || [];
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

    // Ders kazanımları
    const outcomes = data.DersKazanimlari || data.dersKazanimlari || data.Outcomes || [];
    if (Array.isArray(outcomes) && outcomes.length > 0) {
        await supabase.from('course_outcomes').delete().eq('course_detail_id', detailId);
        for (const outcome of outcomes) {
            await supabase.from('course_outcomes').insert({
                course_detail_id: detailId,
                outcome_no: outcome.SiraNo || outcome.No || 0,
                outcome: stripHtml(outcome.Kazanim || outcome.kazanim || outcome.Outcome || '')
            });
        }
    }

    // Değerlendirme kriterleri
    const evals = data.DegerlendirmeKriterleri || data.degerlendirmeKriterleri || data.Evaluations || [];
    if (Array.isArray(evals) && evals.length > 0) {
        await supabase.from('course_evaluations').delete().eq('course_detail_id', detailId);
        for (const ev of evals) {
            await supabase.from('course_evaluations').insert({
                course_detail_id: detailId,
                eval_type: ev.DegerlendirmeTuru || ev.Tur || ev.Type || '',
                weight_percent: ev.Oran || ev.oran || ev.Weight || null,
                count: ev.Sayi || ev.sayi || ev.Count || null
            });
        }
    }
}
