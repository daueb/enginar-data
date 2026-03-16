require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// --- GÜVENLİK AYARI ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey) throw new Error("❌ Supabase URL/Key eksik!");
if (!OPENAI_API_KEY) throw new Error("❌ OPENAI_API_KEY eksik!");

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

// --- EMBEDDING ---
async function getEmbedding(text) {
    try {
        const res = await axios.post('https://api.openai.com/v1/embeddings', {
            model: 'text-embedding-3-small',
            input: text
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return res.data.data[0].embedding;
    } catch (err) {
        console.error('❌ Embedding hatası:', err.response?.data?.error?.message || err.message);
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
async function ensureRagSource(name, type) {
    const url = `bilgipaketi://${type}`;
    const { data: existing } = await supabase.from('rag_sources')
        .select('id').eq('url', url).maybeSingle();
    if (existing) return existing.id;

    const { data: inserted } = await supabase.from('rag_sources')
        .insert({ url, name, type: 'bilgipaketi', status: 'active' })
        .select('id').single();
    return inserted?.id;
}

// --- DOKÜMAN + CHUNK KAYDI ---
async function saveChunks(sourceId, docUrl, title, text, metadata) {
    // Doküman kaydet
    let docId;
    const { data: existing } = await supabase.from('rag_documents')
        .select('id').eq('url', docUrl).maybeSingle();

    if (existing) {
        docId = existing.id;
        await supabase.from('rag_documents').update({
            title, content: text.substring(0, 50000), metadata, status: 'processed'
        }).eq('id', docId);
    } else {
        const { data: ins } = await supabase.from('rag_documents')
            .insert({ source_id: sourceId, url: docUrl, title, content: text.substring(0, 50000), metadata, status: 'processed' })
            .select('id').single();
        docId = ins?.id;
    }
    if (!docId) return 0;

    // Eski chunk'ları temizle
    await supabase.from('rag_chunks').delete().eq('document_id', docId);

    // Chunk + embed
    const chunks = chunkText(text);
    let saved = 0;
    for (let i = 0; i < chunks.length; i++) {
        const embedding = await getEmbedding(chunks[i]);
        if (!embedding) continue;

        const { error } = await supabase.from('rag_chunks').insert({
            document_id: docId,
            chunk_index: i,
            content: chunks[i],
            embedding,
            metadata: { ...metadata, chunk_index: i, total_chunks: chunks.length }
        });
        if (!error) saved++;
        await delay(100);
    }
    return saved;
}

// =====================================================
// 1. PROGRAM BİLGİ SAYFALARI → VEKTÖR
// =====================================================
async function vectorizeProgramInfo() {
    console.log('\n📚 Program Bilgi Sayfaları Vektörize Ediliyor...');
    const sourceId = await ensureRagSource('Bilgipaketi - Bölüm Bilgileri', 'program_info');
    if (!sourceId) return;

    const { data: pages } = await supabase.from('program_info').select('*');
    if (!pages || pages.length === 0) { console.log('   ⚠️ program_info tablosu boş'); return; }

    let total = 0;
    for (const page of pages) {
        const text = [page.content_tr, page.content_en].filter(Boolean).join('\n\n');
        if (text.length < 50) continue;

        const chunks = await saveChunks(sourceId,
            `bilgipaketi://program_info/${page.program_id}/${page.page_key}`,
            `${page.page_key} - Program ${page.program_id}`,
            text,
            { source: 'bilgipaketi', type: 'program_info', program_id: page.program_id, page_key: page.page_key }
        );
        total += chunks;
    }
    console.log(`   ✅ ${pages.length} sayfa -> ${total} chunk vektörize edildi`);
}

// =====================================================
// 2. DERS DETAYLARI → VEKTÖR
// =====================================================
async function vectorizeCourseDetails() {
    console.log('\n📖 Ders Detayları Vektörize Ediliyor...');
    const sourceId = await ensureRagSource('Bilgipaketi - Ders Detayları', 'course_details');
    if (!sourceId) return;

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
        // Ders hakkındaki tüm metni birleştir
        const parts = [
            detail.course_code && detail.course_name ? `${detail.course_code} - ${detail.course_name}` : '',
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
            { source: 'bilgipaketi', type: 'course_detail', bim_kodu: detail.bim_kodu, course_code: detail.course_code }
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
            { source: 'bilgipaketi', type: 'curriculum', program_id: curr.program_id, muf_no: curr.muf_no }
        );
        total += chunks;
    }
    console.log(`   ✅ ${curricula.length} müfredat -> ${total} chunk vektörize edildi`);
}

// =====================================================
// 4. PROGRAM YETERLİLİKLERİ → VEKTÖR
// =====================================================
async function vectorizeQualifications() {
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
        const parts = [`Program ${programId} Yeterlilikleri:`];
        for (const item of items) {
            parts.push(`${item.qualification_no}. ${item.content_tr}`);
            if (item.content_en) parts.push(`   (EN: ${item.content_en})`);
        }
        const text = parts.join('\n');

        const chunks = await saveChunks(sourceId,
            `bilgipaketi://qualifications/${programId}`,
            `Program Yeterlilikleri - ${programId}`,
            text,
            { source: 'bilgipaketi', type: 'qualifications', program_id: parseInt(programId) }
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

    await vectorizeProgramInfo();
    await vectorizeCourseDetails();
    await vectorizeCurricula();
    await vectorizeQualifications();

    console.log(`\n${'='.repeat(60)}`);
    console.log('🚀 Bilgipaketi Vektörizasyonu Tamamlandı!');
    console.log('='.repeat(60));
})();
