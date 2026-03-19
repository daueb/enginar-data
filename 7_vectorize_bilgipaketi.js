require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// --- GÜVENLİK AYARI ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey) throw new Error("❌ Supabase URL/Key eksik!");
if (!GEMINI_API_KEY) throw new Error("❌ GEMINI_API_KEY eksik! https://aistudio.google.com/apikey adresinden ucretsiz al.");

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

// --- EMBEDDING (Google Gemini - Ucretsiz, 768 boyut) ---
// Rate limiter: Gemini free tier = 1000 req/dakika
let embedRequestCount = 0;
let embedMinuteStart = Date.now();
const MAX_EMBEDS_PER_MINUTE = 900; // 1000 limitin altinda kal

// Ardışık hata sayacı: üst üste 3 quota hatası → embedding tamamen kapat
let consecutiveEmbedFailures = 0;
let embeddingDisabled = false;
let successfulEmbeddings = 0;
let skippedEmbeddings = 0;

async function getEmbedding(text, retryCount = 0) {
    if (embeddingDisabled) {
        skippedEmbeddings++;
        return null;
    }

    // Rate limiting: dakikada max 900 istek
    embedRequestCount++;
    const elapsed = Date.now() - embedMinuteStart;
    if (elapsed >= 60000) {
        embedRequestCount = 1;
        embedMinuteStart = Date.now();
    } else if (embedRequestCount >= MAX_EMBEDS_PER_MINUTE) {
        const waitMs = 60000 - elapsed + 2000;
        console.log(`   ⏳ Embedding rate limit: ${Math.round(waitMs/1000)}sn bekleniyor...`);
        await delay(waitMs);
        embedRequestCount = 1;
        embedMinuteStart = Date.now();
    }

    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
            {
                content: { parts: [{ text: text.substring(0, 8000) }] },
                outputDimensionality: 768
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        consecutiveEmbedFailures = 0; // Başarılı → sıfırla
        successfulEmbeddings++;
        return res.data.embedding.values;
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        // Quota/rate limit hatasi: bekle ve tekrar dene (max 2 deneme)
        if (msg.includes('Quota exceeded') || msg.includes('RATE_LIMIT') || err.response?.status === 429) {
            if (retryCount < 2) {
                const waitSec = retryCount === 0 ? 5 : 10;
                console.log(`   ⏳ Embedding quota - ${waitSec}sn bekleniyor (deneme ${retryCount + 1}/2)...`);
                await delay(waitSec * 1000);
                embedRequestCount = 0;
                embedMinuteStart = Date.now();
                return getEmbedding(text, retryCount + 1);
            }
            consecutiveEmbedFailures++;
            if (consecutiveEmbedFailures >= 3) {
                console.warn('⚠️ ═══════════════════════════════════════════════════');
                console.warn('⚠️ Embedding kotası tükendi! Geri kalan chunk\'lar embedding\'siz kaydedilecek.');
                console.warn('⚠️ Kota yenilenince bu script\'i tekrar çalıştırarak embedding ekleyebilirsin.');
                console.warn('⚠️ ═══════════════════════════════════════════════════');
                embeddingDisabled = true;
                skippedEmbeddings++;
            } else {
                console.warn(`⚠️ Embedding başarısız (ardışık hata: ${consecutiveEmbedFailures}/3)`);
            }
            return null;
        }
        console.error('❌ Embedding hatası:', msg);
        return null;
    }
}

// --- CHUNKING ---
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    if (!text || text.length < 50) return [];
    const words = text.split(/\s+/);
    const chunks = [];
    let start = 0;
    while (start < words.length) {
        const end = Math.min(start + chunkSize, words.length);
        const chunk = words.slice(start, end).join(' ');
        if (chunk.length > 30) chunks.push(chunk);
        start += chunkSize - overlap;
    }
    return chunks;
}

// --- RAG SOURCE ---
// Gerçek tablo: id (uuid), title (text), source_type (text), url (text), category (text), department_id (uuid)
async function ensureRagSource(name, type) {
    const url = `bilgipaketi://${type}`;
    const { data: existing } = await supabase.from('rag_sources')
        .select('id').eq('url', url).maybeSingle();
    if (existing) return existing.id;

    const { data: inserted } = await supabase.from('rag_sources')
        .insert({ url, title: name, source_type: 'html', category: type })
        .select('id').single();
    return inserted?.id;
}

// --- DOKÜMAN + CHUNK KAYDI ---
// rag_documents: doc_id (text PK), title, url, category, source_type, content_hash
// rag_chunks: id (int8), doc_id (text FK), chunk_index, chunk_text, embedding, created_at
const crypto = require('crypto');

async function saveChunks(sourceId, docUrl, title, text, metadata) {
    const docId = crypto.createHash('md5').update(docUrl).digest('hex');
    const contentHash = crypto.createHash('md5').update(text).digest('hex');
    const department = metadata?.department || null;

    // Chunk metadata — AI filtreleme için
    const chunkMeta = { source_type: 'bilgipaketi' };
    if (department) chunkMeta.department = department;
    if (metadata?.course_code) chunkMeta.course_code = metadata.course_code;
    if (metadata?.program_id) chunkMeta.program_id = metadata.program_id;
    if (metadata?.page_key) chunkMeta.page_key = metadata.page_key;

    const { data: existing } = await supabase.from('rag_documents')
        .select('doc_id, content_hash').eq('doc_id', docId).maybeSingle();

    if (existing) {
        if (existing.content_hash === contentHash) {
            const { count } = await supabase.from('rag_chunks')
                .select('id', { count: 'exact', head: true }).eq('doc_id', docId);
            if (count && count > 0) return 0;
        }
        await supabase.from('rag_documents').update({
            title, content_hash: contentHash,
            source_type: 'bilgipaketi',
            category: metadata?.source || 'bilgipaketi',
            department: department,
            updated_from_source_at: new Date().toISOString()
        }).eq('doc_id', docId);
    } else {
        const { error: docErr } = await supabase.from('rag_documents').insert({
            doc_id: docId, url: docUrl, title,
            source_type: 'bilgipaketi',
            category: metadata?.source || 'bilgipaketi',
            department: department,
            content_hash: contentHash
        });
        if (docErr) { console.error(`   ❌ Doküman eklenemedi: ${docErr.message}`); return 0; }
    }

    // Eski chunk'ları temizle
    await supabase.from('rag_chunks').delete().eq('doc_id', docId);

    // Chunk + embed
    const chunks = chunkText(text);
    let saved = 0;
    for (let i = 0; i < chunks.length; i++) {
        const embedding = await getEmbedding(chunks[i]);

        const chunkData = {
            doc_id: docId,
            chunk_index: i,
            chunk_text: chunks[i],
            metadata: chunkMeta
        };
        if (embedding) chunkData.embedding = embedding;

        const { error } = await supabase.from('rag_chunks').insert(chunkData);
        if (error) {
            // metadata kolonu yoksa onsuz dene
            delete chunkData.metadata;
            if (!embedding) delete chunkData.embedding;
            const { error: retryErr } = await supabase.from('rag_chunks').insert(chunkData);
            if (!retryErr) saved++;
        } else {
            saved++;
        }
        await delay(100);
    }
    return saved;
}

// =====================================================
// PROGRAM ADLARINI CACHE'LE (chunk'lara bolum bilgisi eklemek icin)
// =====================================================
async function buildProgramNameMap() {
    const map = {};
    // curricula tablosundan program_id -> name eslestirmesi
    const { data: curricula } = await supabase.from('curricula').select('program_id, name');
    if (curricula) {
        for (const c of curricula) {
            if (!map[c.program_id]) map[c.program_id] = c.name;
        }
    }
    // program_info'dan da dene (bolum_tanitimi sayfasinda isim olabilir)
    const { data: infos } = await supabase.from('program_info')
        .select('program_id, content_tr')
        .eq('page_key', 'bolum_tanitimi');
    if (infos) {
        for (const info of infos) {
            if (!map[info.program_id] && info.content_tr) {
                // Ilk satirdan program adini cikar
                const firstLine = info.content_tr.split('\n')[0].substring(0, 100);
                if (firstLine.length > 5) map[info.program_id] = firstLine;
            }
        }
    }
    return map;
}

// =====================================================
// 1. PROGRAM BİLGİ SAYFALARI → VEKTÖR
// =====================================================
async function vectorizeProgramInfo(programNames) {
    console.log('\n📚 Program Bilgi Sayfaları Vektörize Ediliyor...');
    const sourceId = await ensureRagSource('Bilgipaketi - Bölüm Bilgileri', 'program_info');
    if (!sourceId) return;

    const { data: pages } = await supabase.from('program_info').select('*');
    if (!pages || pages.length === 0) { console.log('   ⚠️ program_info tablosu boş'); return; }

    // Sayfa anahtarlarinin Turkce karsiliklari
    const PAGE_LABELS = {
        bolum_tanitimi: 'Bölüm Tanıtımı',
        kazanilan_derece: 'Kazanılan Derece',
        kabul_kosullari: 'Kabul Koşulları',
        onceki_ogrenme: 'Önceki Öğrenme',
        yeterlilik_kosullari: 'Yeterlilik Koşulları',
        programin_amaci: 'Programın Amacı',
        program_ciktilari: 'Program Çıktıları',
        program_yeterlilikleri: 'Program Yeterlilikleri',
        mezunlarin_istihdam: 'Mezunların İstihdam Profili',
        ust_derece_programlara_gecis: 'Üst Derece Programlara Geçiş'
    };

    let total = 0;
    for (const page of pages) {
        const progName = programNames[page.program_id] || `Program ${page.program_id}`;
        const pageLabel = PAGE_LABELS[page.page_key] || page.page_key;

        // Chunk'a bolum + sayfa konteksti ekle
        const prefix = `[${progName} | ${pageLabel}]\n`;
        const text = prefix + [page.content_tr, page.content_en].filter(Boolean).join('\n\n');
        if (text.length < 50) continue;

        const chunks = await saveChunks(sourceId,
            `bilgipaketi://program_info/${page.program_id}/${page.page_key}`,
            `${progName} - ${pageLabel}`,
            text,
            { source: 'bilgipaketi', type: 'program_info', program_id: page.program_id, page_key: page.page_key, department: progName }
        );
        total += chunks;
    }
    console.log(`   ✅ ${pages.length} sayfa -> ${total} chunk vektörize edildi`);
}

// =====================================================
// 2. DERS DETAYLARI → VEKTÖR
// =====================================================
async function vectorizeCourseDetails(programNames) {
    console.log('\n📖 Ders Detayları Vektörize Ediliyor...');
    const sourceId = await ensureRagSource('Bilgipaketi - Ders Detayları', 'course_details');
    if (!sourceId) return;

    // BimKodu -> program adi eslestirmesi icin curriculum_courses + curricula join
    const bimToProgramMap = {};
    const { data: ccRows } = await supabase.from('curriculum_courses')
        .select('bim_kodu, curriculum_id');
    if (ccRows) {
        const { data: currRows } = await supabase.from('curricula').select('id, program_id, name');
        const currMap = {};
        if (currRows) {
            for (const c of currRows) currMap[c.id] = { program_id: c.program_id, name: c.name };
        }
        for (const cc of ccRows) {
            if (cc.bim_kodu && currMap[cc.curriculum_id]) {
                bimToProgramMap[cc.bim_kodu] = currMap[cc.curriculum_id].name;
            }
        }
    }

    // Tüm ders detaylarını çek (pagination)
    let allDetails = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
        const { data } = await supabase.from('course_details').select('*').range(from, from + PAGE - 1);
        if (!data || data.length === 0) break;
        allDetails = allDetails.concat(data);
        if (data.length < PAGE) break;
        from += PAGE;
    }

    if (allDetails.length === 0) { console.log('   ⚠️ course_details tablosu boş'); return; }

    let total = 0;
    for (const detail of allDetails) {
        // Dersin hangi programa ait oldugunu bul
        const progName = bimToProgramMap[detail.bim_kodu] || '';
        const progPrefix = progName ? `[${progName}] ` : '';

        // Ders hakkındaki tüm metni birleştir
        const parts = [
            progPrefix + (detail.course_code && detail.course_name ? `${detail.course_code} - ${detail.course_name}` : ''),
            detail.course_name_en ? `(${detail.course_name_en})` : '',
            detail.description ? `Ders Tanımı: ${detail.description}` : '',
            detail.teaching_methods ? `Öğretme Yöntemleri: ${detail.teaching_methods}` : '',
            detail.textbook ? `Ders Kaynakları: ${detail.textbook}` : '',
            detail.other_resources ? `Diğer Kaynaklar: ${detail.other_resources}` : '',
            detail.prerequisites ? `Ön Koşul: ${detail.prerequisites}` : '',
            detail.language ? `Dil: ${detail.language}` : '',
            detail.level ? `Seviye: ${detail.level}` : '',
            detail.type ? `Tür: ${detail.type}` : '',
        ];

        // Haftalık konuları ekle
        const { data: topics } = await supabase.from('course_weekly_topics')
            .select('week, topic')
            .eq('course_detail_id', detail.id)
            .order('week');
        if (topics && topics.length > 0) {
            parts.push('Haftalık Konular:');
            for (const t of topics) {
                parts.push(`  Hafta ${t.week}: ${t.topic}`);
            }
        }

        // Kazanımları ekle
        const { data: outcomes } = await supabase.from('course_outcomes')
            .select('outcome_no, outcome')
            .eq('course_detail_id', detail.id)
            .order('outcome_no');
        if (outcomes && outcomes.length > 0) {
            parts.push('Ders Kazanımları:');
            for (const o of outcomes) {
                parts.push(`  ${o.outcome_no}. ${o.outcome}`);
            }
        }

        const text = parts.filter(Boolean).join('\n');
        if (text.length < 50) continue;

        const chunks = await saveChunks(sourceId,
            `bilgipaketi://course_details/${detail.bim_kodu}`,
            `${detail.course_code} - ${detail.course_name}`,
            text,
            { source: 'bilgipaketi', type: 'course_detail', bim_kodu: detail.bim_kodu, course_code: detail.course_code, department: progName || null }
        );
        total += chunks;

        if (total % 100 === 0 && total > 0) {
            console.log(`   ... ${total} chunk işlendi`);
        }
    }
    console.log(`   ✅ ${allDetails.length} ders -> ${total} chunk vektörize edildi`);
}

// =====================================================
// 3. MÜFREDAT BİLGİLERİ → VEKTÖR
// =====================================================
async function vectorizeCurricula() {
    console.log('\n📋 Müfredat Bilgileri Vektörize Ediliyor...');
    const sourceId = await ensureRagSource('Bilgipaketi - Müfredatlar', 'curricula');
    if (!sourceId) return;

    const { data: curricula } = await supabase.from('curricula').select('*');
    if (!curricula || curricula.length === 0) { console.log('   ⚠️ curricula tablosu boş'); return; }

    let total = 0;
    for (const curr of curricula) {
        // Bu müfredattaki dersleri çek
        const { data: courses } = await supabase.from('curriculum_courses')
            .select('*')
            .eq('curriculum_id', curr.id)
            .order('year').order('semester');

        if (!courses || courses.length === 0) continue;

        // Müfredat metnini oluştur
        const parts = [`Müfredat: ${curr.name} (${curr.year})`];
        if (curr.name_en) parts.push(`Program: ${curr.name_en}`);

        let currentYear = 0;
        let currentSemester = 0;
        for (const c of courses) {
            if (c.year !== currentYear || c.semester !== currentSemester) {
                currentYear = c.year;
                currentSemester = c.semester;
                parts.push(`\n${currentYear}. Sınıf - ${currentSemester === 1 ? 'Güz' : 'Bahar'} Dönemi:`);
            }
            const elective = c.is_elective ? ' (Seçmeli)' : '';
            parts.push(`  ${c.course_code} - ${c.course_name}${elective} | Kredi: ${c.credit || '?'} | AKTS: ${c.ects || '?'}`);
        }

        const text = parts.join('\n');
        const chunks = await saveChunks(sourceId,
            `bilgipaketi://curriculum/${curr.program_id}/${curr.muf_no}`,
            `Müfredat: ${curr.name}`,
            text,
            { source: 'bilgipaketi', type: 'curriculum', program_id: curr.program_id, muf_no: curr.muf_no, department: curr.name }
        );
        total += chunks;
    }
    console.log(`   ✅ ${curricula.length} müfredat -> ${total} chunk vektörize edildi`);
}

// =====================================================
// 4. PROGRAM YETERLİLİKLERİ → VEKTÖR
// =====================================================
async function vectorizeQualifications(programNames) {
    console.log('\n🎯 Program Yeterlilikleri Vektörize Ediliyor...');
    const sourceId = await ensureRagSource('Bilgipaketi - Program Yeterlilikleri', 'qualifications');
    if (!sourceId) return;

    // Program ID'lerine göre grupla
    const { data: quals } = await supabase.from('program_qualifications').select('*').order('program_id').order('qualification_no');
    if (!quals || quals.length === 0) { console.log('   ⚠️ program_qualifications tablosu boş'); return; }

    // Program ID'ye göre grupla
    const grouped = {};
    for (const q of quals) {
        if (!grouped[q.program_id]) grouped[q.program_id] = [];
        grouped[q.program_id].push(q);
    }

    let total = 0;
    for (const [programId, items] of Object.entries(grouped)) {
        const progName = programNames[programId] || `Program ${programId}`;
        const parts = [`[${progName}] Program Yeterlilikleri:`];
        for (const item of items) {
            parts.push(`${item.qualification_no}. ${item.content_tr}`);
            if (item.content_en) parts.push(`   (EN: ${item.content_en})`);
        }
        const text = parts.join('\n');

        const chunks = await saveChunks(sourceId,
            `bilgipaketi://qualifications/${programId}`,
            `${progName} - Program Yeterlilikleri`,
            text,
            { source: 'bilgipaketi', type: 'qualifications', program_id: parseInt(programId), department: progName }
        );
        total += chunks;
    }
    console.log(`   ✅ ${Object.keys(grouped).length} program -> ${total} chunk vektörize edildi`);
}

// =====================================================
// ANA FONKSİYON
// =====================================================
(async () => {
    console.log('🔄 Bilgipaketi Veri Vektörizasyonu Başlatılıyor...\n');

    // Program ID -> Program Adi eslestirmesi (chunk'lara bolum bilgisi eklemek icin)
    const programNames = await buildProgramNameMap();
    console.log(`📋 ${Object.keys(programNames).length} program adı eşleştirildi.\n`);

    await vectorizeProgramInfo(programNames);
    await vectorizeCourseDetails(programNames);
    await vectorizeCurricula();
    await vectorizeQualifications(programNames);

    console.log(`\n${'='.repeat(60)}`);
    console.log('🚀 Bilgipaketi Vektörizasyonu Tamamlandı!');
    console.log(`   📊 Embedding: ${successfulEmbeddings} başarılı, ${skippedEmbeddings} atlandı${embeddingDisabled ? ' (kota doldu — tekrar çalıştır)' : ''}`);
    console.log('='.repeat(60));
})();
