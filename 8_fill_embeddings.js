require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey) throw new Error('❌ SUPABASE_URL veya KEY eksik');
if (!GEMINI_API_KEY) throw new Error('❌ GEMINI_API_KEY eksik');

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Gemini rate limit: 1500 req/gün, ~25/dk güvenli
const BATCH_SIZE = 20;       // Her batch'te 20 chunk
const DELAY_BETWEEN = 3000;  // Batch'ler arası 3sn

async function getEmbedding(text, retryCount = 0) {
    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
            {
                content: { parts: [{ text: text.substring(0, 8000) }] },
                outputDimensionality: 768
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        return res.data.embedding.values;
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        if ((msg.includes('Quota') || msg.includes('RATE_LIMIT') || err.response?.status === 429) && retryCount < 3) {
            const waitSec = 15 * (retryCount + 1);
            console.log(`   ⏳ Rate limit - ${waitSec}sn bekleniyor (deneme ${retryCount + 1}/3)...`);
            await delay(waitSec * 1000);
            return getEmbedding(text, retryCount + 1);
        }
        console.error(`   ❌ Embedding hatası: ${msg}`);
        return null;
    }
}

async function main() {
    // Embedding'siz chunk sayısı
    const { count: nullCount } = await supabase
        .from('rag_chunks')
        .select('id', { count: 'exact', head: true })
        .is('embedding', null);

    const { count: totalCount } = await supabase
        .from('rag_chunks')
        .select('id', { count: 'exact', head: true });

    console.log(`📊 Toplam chunk: ${totalCount}`);
    console.log(`❌ Embedding'siz: ${nullCount}`);
    console.log(`✅ Embedding'li: ${totalCount - nullCount}`);

    if (nullCount === 0) {
        console.log('🎉 Tüm chunk\'lar zaten embed edilmiş!');
        return;
    }

    console.log(`\n🚀 ${nullCount} chunk embed edilecek...`);
    console.log(`   Tahmini süre: ~${Math.ceil(nullCount / BATCH_SIZE * 3 / 60)} dakika\n`);

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let consecutiveErrors = 0;

    while (true) {
        // Embedding'siz chunk'ları al
        const { data: chunks, error } = await supabase
            .from('rag_chunks')
            .select('id, chunk_text')
            .is('embedding', null)
            .order('id', { ascending: true })
            .limit(BATCH_SIZE);

        if (error) {
            console.error('❌ Supabase hatası:', error.message);
            break;
        }
        if (!chunks || chunks.length === 0) break;

        for (const chunk of chunks) {
            const embedding = await getEmbedding(chunk.chunk_text);

            if (embedding) {
                const { error: updateErr } = await supabase
                    .from('rag_chunks')
                    .update({ embedding })
                    .eq('id', chunk.id);

                if (updateErr) {
                    console.error(`   ❌ Update hatası (id=${chunk.id}):`, updateErr.message);
                    failed++;
                } else {
                    succeeded++;
                    consecutiveErrors = 0;
                }
            } else {
                failed++;
                consecutiveErrors++;
                if (consecutiveErrors >= 5) {
                    console.error('\n🛑 5 ardışık hata! Quota muhtemelen doldu. Daha sonra tekrar çalıştırın.');
                    console.log(`   ✅ ${succeeded} başarılı | ❌ ${failed} başarısız | 📊 ${totalCount - nullCount + succeeded}/${totalCount} toplam`);
                    return;
                }
            }

            processed++;
            if (processed % 50 === 0) {
                console.log(`   📈 İlerleme: ${processed}/${nullCount} (✅ ${succeeded} | ❌ ${failed})`);
            }

            // Her istek arası kısa bekleme
            await delay(200);
        }

        // Batch arası bekleme
        console.log(`   ✅ Batch tamamlandı: ${processed}/${nullCount}`);
        await delay(DELAY_BETWEEN);
    }

    console.log(`\n🎉 Tamamlandı!`);
    console.log(`   ✅ Başarılı: ${succeeded}`);
    console.log(`   ❌ Başarısız: ${failed}`);
    console.log(`   📊 Toplam embed'li: ${totalCount - nullCount + succeeded}/${totalCount}`);
}

main().catch(console.error);
