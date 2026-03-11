// /scripts/sync_supabase.js

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// --- 1. AYARLAR VE GÜVENLİK ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Hata: Supabase URL veya Key bulunamadı!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. HEDEF KLASÖR ---
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- 3. PAGINATION HELPER ---
const PAGE_SIZE = 1000;

async function fetchAllRows(tableName) {
    let allData = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from(tableName)
            .select('*')
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;

        allData = allData.concat(data);

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }

    return allData;
}

// --- 4. ANA SENKRONİZASYON ---
async function syncDataTables() {
    console.log('🔄 Data Sync Başlatılıyor (Supabase -> JSON)...');

    try {
        let tables = [];

        // --- ADIM A: RPC ile tablo listesi ---
        const { data: rpcData, error: rpcError } = await supabase.rpc('get_public_tables');

        if (!rpcError && rpcData && rpcData.length > 0) {
            console.log(`📡 Supabase'den otomatik tablo listesi alındı: ${rpcData.length} tablo.`);

            // 🚫 RAG tablolarını (kaynak + index) dump'a dahil etme
            const EXCLUDED_TABLES = new Set(['rag_sources', 'rag_documents', 'rag_chunks']);
            tables = rpcData.filter(t => !EXCLUDED_TABLES.has(t));

        } else {
            console.log('⚠️ Otomatik liste alınamadı. Manuel liste kullanılıyor.');

            tables = [
                'pins',
                'types',
                'classes',
                'offices',
                'foods',
                'polygons',
                'widgets',
                'stops',
                'routes',
                'exams',
                'academic_calendar',
                'academics',
                'courses',
                'sessions',
                'classrooms',
                'versions.json'
            ];
        }

        console.log(`📋 İşlenecek Tablolar: ${tables.join(', ')}`);

        // --- ADIM B: Eski JSON temizliği ---
        if (fs.existsSync(DATA_DIR)) {
            const existingFiles = fs.readdirSync(DATA_DIR);
            for (const file of existingFiles) {
                if (file.endsWith('.json')) {
                    fs.unlinkSync(path.join(DATA_DIR, file));
                }
            }
            console.log('🧹 Eski JSON dosyaları temizlendi.');
        }

        // --- ADIM C: Verileri çek (pagination ile) ---
        for (const tableName of tables) {
            try {
                const data = await fetchAllRows(tableName);

                fs.writeFileSync(
                    path.join(DATA_DIR, `${tableName}.json`),
                    JSON.stringify(data, null, 2)
                );

                console.log(`✅ Oluşturuldu: ${tableName}.json (${data.length} satır)`);
            } catch (err) {
                console.error(`❌ Hata (${tableName}):`, err.message);
                continue;
            }
        }

        console.log(`🏁 Data Sync Başarıyla Tamamlandı.`);

    } catch (err) {
        console.error('🔥 Kritik Sync Hatası:', err.message);
        process.exit(1);
    }
}

syncDataTables();
