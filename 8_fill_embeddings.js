require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL veya KEY eksik');
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY eksik');

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Gemini batchEmbedContents: tek istekte 100 text embed eder
// Bu sayede 8000 chunk = ~80 istek (eskiden 8000 istek gerekiyordu)
const BATCH_SIZE = 100;         // Gemini batch limiti: 100
const DB_FETCH_SIZE = 500;      // Supabase'den her seferde 500 chunk cek
const DELAY_BETWEEN = 2000;     // Batch'ler arasi 2sn (dakikada ~25 batch = 2500 chunk)

async function batchEmbed(texts, retryCount = 0) {
    try {
        const requests = texts.map(text => ({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text: text.substring(0, 8000) }] },
            outputDimensionality: 768
        }));

        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${GEMINI_API_KEY}`,
            { requests },
            { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
        );

        return res.data.embeddings.map(e => e.values);
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;

        if ((msg.includes('Quota') || msg.includes('RATE_LIMIT') || msg.includes('quota') || err.response?.status === 429) && retryCount < 3) {
            const waitSec = 20 * (retryCount + 1);
            console.log(`   ⏳ Rate limit - ${waitSec}sn bekleniyor (deneme ${retryCount + 1}/3)...`);
            await delay(waitSec * 1000);
            return batchEmbed(texts, retryCount + 1);
        }
        console.error(`   ❌ Batch embedding hatasi: ${msg}`);
        return null;
    }
}

async function main() {
    // Embedding'siz chunk sayisi
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
        console.log('🎉 Tum chunklar zaten embed edilmis!');
        return;
    }

    const batchCount = Math.ceil(nullCount / BATCH_SIZE);
    const estimatedMin = Math.ceil(batchCount * DELAY_BETWEEN / 60000) + 1;
    console.log(`\n🚀 ${nullCount} chunk embed edilecek...`);
    console.log(`   📦 Batch boyutu: ${BATCH_SIZE} chunk/istek (toplam ~${batchCount} API istegi)`);
    console.log(`   ⏱️  Tahmini sure: ~${estimatedMin} dakika\n`);

    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;
    let consecutiveErrors = 0;

    while (true) {
        // Embedding'siz chunklari al (buyuk batch)
        const { data: chunks, error } = await supabase
            .from('rag_chunks')
            .select('id, chunk_text')
            .is('embedding', null)
            .order('id', { ascending: true })
            .limit(DB_FETCH_SIZE);

        if (error) {
            console.error('❌ Supabase hatasi:', error.message);
            break;
        }
        if (!chunks || chunks.length === 0) break;

        // 100'erli batch'lere bol
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
            const batch = chunks.slice(i, i + BATCH_SIZE);
            const texts = batch.map(c => c.chunk_text);

            // Toplu embedding al
            const embeddings = await batchEmbed(texts);

            if (!embeddings) {
                totalFailed += batch.length;
                consecutiveErrors++;
                if (consecutiveErrors >= 3) {
                    console.error('\n🛑 3 ardisik batch hatasi! Quota muhtemelen doldu.');
                    console.log(`   ✅ ${totalSucceeded} basarili | ❌ ${totalFailed} basarisiz | 📊 ${totalCount - nullCount + totalSucceeded}/${totalCount} toplam`);
                    return;
                }
                continue;
            }

            consecutiveErrors = 0;

            // Her chunk'i embedding ile guncelle
            let batchSuccess = 0;
            for (let j = 0; j < batch.length; j++) {
                const { error: updateErr } = await supabase
                    .from('rag_chunks')
                    .update({ embedding: embeddings[j] })
                    .eq('id', batch[j].id);

                if (updateErr) {
                    totalFailed++;
                } else {
                    totalSucceeded++;
                    batchSuccess++;
                }
            }

            totalProcessed += batch.length;
            const pct = Math.round(totalProcessed / nullCount * 100);
            console.log(`   📦 Batch ${Math.ceil(totalProcessed / BATCH_SIZE)}/${batchCount}: ${batchSuccess}/${batch.length} basarili | Toplam: ${totalProcessed}/${nullCount} (%${pct})`);

            // Batch arasi bekleme
            await delay(DELAY_BETWEEN);
        }
    }

    console.log(`\n🎉 Tamamlandi!`);
    console.log(`   ✅ Basarili: ${totalSucceeded}`);
    console.log(`   ❌ Basarisiz: ${totalFailed}`);
    console.log(`   📊 Toplam embed'li: ${totalCount - nullCount + totalSucceeded}/${totalCount}`);
}

main().catch(console.error);
