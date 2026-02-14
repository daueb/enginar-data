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

// --- 3. ANA SENKRONİZASYON ---
async function syncDataTables() {
    console.log('🔄 Data Sync Başlatılıyor (Supabase -> JSON)...');

    try {
        let tables = [];

        // --- ADIM A: RPC ile tablo listesi ---
        const { data: rpcData, error: rpcError } = await supabase.rpc('get_public_tables');
        
        if (!rpcError && rpcData && rpcData.length > 0) {
            console.log(`📡 Supabase'den otomatik tablo listesi alındı: ${rpcData.length} tablo.`);

            // 🚫 rag_sources hariç hepsini al
            tables = rpcData.filter(t => t !== 'rag_sources');

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
                'classrooms'
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

        // --- ADIM C: Verileri çek ---
        for (const tableName of tables) {

            const { data, error } = await supabase
                .from(tableName)
                .select('*')
                .order('id', { ascending: true });

            if (error) {
                console.error(`❌ Hata (${tableName}):`, error.message);
                continue;
            }

            fs.writeFileSync(
                path.join(DATA_DIR, `${tableName}.json`),
                JSON.stringify(data, null, 2)
            );

            console.log(`✅ Oluşturuldu: ${tableName}.json (${data.length} satır)`);
        }

        console.log(`🏁 Data Sync Başarıyla Tamamlandı.`);

    } catch (err) {
        console.error('🔥 Kritik Sync Hatası:', err.message);
        process.exit(1);
    }
}

syncDataTables();
