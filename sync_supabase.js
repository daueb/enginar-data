const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Lokal testler için (GitHub'da secretlardan okur)

// --- 1. AYARLAR VE GÜVENLİK ---
// GitHub Secrets'ta 'SUPABASE_KEY' veya 'SUPABASE_SERVICE_KEY' olarak tanımlayabilirsin.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Hata: Supabase URL veya Key bulunamadı! .env dosyasını veya GitHub Secrets'ı kontrol et.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. HEDEF KLASÖR ---
const DATA_DIR = path.join(__dirname, 'data');

// Klasör yoksa oluştur
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- 3. ANA SENKRONİZASYON FONKSİYONU ---
async function syncDataTables() {
    console.log('🔄 Data Sync Başlatılıyor (Supabase -> JSON)...');

    try {
        let tables = [];

        // ADIM A: Otomatik Tablo Listesi Çekmeyi Dene (RPC varsa)
        // Eğer veritabanında 'get_public_tables' fonksiyonun yoksa bu kısım hata verir, catch'e düşmez ama else'e düşer.
        const { data: rpcData, error: rpcError } = await supabase.rpc('get_public_tables');
        
        if (!rpcError && rpcData && rpcData.length > 0) {
            console.log(`📡 Supabase'den otomatik tablo listesi alındı: ${rpcData.length} tablo.`);
            tables = rpcData;
        } else {
            // ADIM B: RPC Yoksa Manuel Listeyi Kullan
            // Senin server.js'deki manuel listenin aynısı:
            console.log('⚠️ Otomatik liste alınamadı veya RPC yok. Manuel liste kullanılıyor.');
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
                'exams'
            ];
        }

        console.log(`📋 İşlenecek Tablolar: ${tables.join(', ')}`);

        // ADIM C: Temizlik (Eski JSON'ları sil ki çöp kalmasın)
        if (fs.existsSync(DATA_DIR)) {
            const existingFiles = fs.readdirSync(DATA_DIR);
            for (const file of existingFiles) {
                if (file.endsWith('.json')) {
                    fs.unlinkSync(path.join(DATA_DIR, file));
                }
            }
            console.log('🧹 Eski JSON dosyaları temizlendi.');
        }

        // ADIM D: Döngüye Gir, Veriyi Çek ve Yaz
        for (const tableName of tables) {
            // Veriyi ID sırasına göre çekiyoruz ki liste karışmasın
            const { data, error } = await supabase
                .from(tableName)
                .select('*')
                .order('id', { ascending: true });

            if (error) {
                console.error(`❌ Hata (${tableName}):`, error.message);
                // Bir tabloda hata olsa bile diğerlerine devam etsin diye continue diyoruz
                continue; 
            }

            // Dosyayı diske yaz
            fs.writeFileSync(path.join(DATA_DIR, `${tableName}.json`), JSON.stringify(data, null, 2));
            console.log(`✅ Oluşturuldu: ${tableName}.json (${data.length} satır)`);
        }

        console.log(`🏁 Data Sync Başarıyla Tamamlandı.`);

    } catch (err) {
        console.error('🔥 Kritik Sync Hatası:', err.message);
        process.exit(1); // Hata varsa GitHub Action'ı başarısız olarak işaretle
    }
}

// Fonksiyonu Çalıştır
syncDataTables();