//scraper.js

const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { createClient } = require('@supabase/supabase-js');
const https = require('https'); // YENİ: Bağlantı kopmasını önleyen modül
require('dotenv').config();

// --- AYARLAR ---
const DEPT_LIST_URL = 'https://www.cankaya.edu.tr/ogrenci_isleri/sinav.php';
const EXAM_TABLE_URL = 'https://www.cankaya.edu.tr/ogrenci_isleri/sinavderskod.php';

// Bekleme Süresi: 5 Saniye (Siteye nefes aldırmak için)
const SLEEP_TIME = 5000; 
// Hata olursa kaç kere tekrar denesin?
const MAX_RETRIES = 5;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- YENİ GÜVENLİK AJANI ---
// Bağlantının kopmasını (Socket Hang Up) engeller
const agent = new https.Agent({  
  keepAlive: true,
  maxSockets: Infinity,
  keepAliveMsecs: 10000
});

let globalCookie = null;

// ADIM 1: Bölümleri ve Çerezi Al
async function getDepartmentsAndCookie() {
    console.log("🔍 Siteye giriş yapılıyor...");
    try {
        const response = await axios.get(DEPT_LIST_URL, { 
            responseType: 'arraybuffer',
            httpsAgent: agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Connection': 'keep-alive'
            }
        });
        
        if (response.headers['set-cookie']) {
            globalCookie = response.headers['set-cookie'];
        }

        const decodedData = iconv.decode(response.data, 'utf-8'); 
        const $ = cheerio.load(decodedData);
        
        let departments = [];
        $('select[name="derskod"] option').each((i, el) => {
            const val = $(el).attr('value');
            if (val && val.trim() !== '' && val !== '0') {
                departments.push(val.trim());
            }
        });

        console.log(`✅ ${departments.length} bölüm bulundu. Tarama başlıyor...`);
        return departments;
    } catch (error) {
        console.error("❌ Giriş başarısız:", error.message);
        return [];
    }
}

// ADIM 2: Güvenli İstek Atan Fonksiyon (Akıllı Timeout + Retry)
async function fetchDepartmentWithRetry(dept, attempt = 1) {
    try {
        // Dinamik Timeout: Her denemede süreyi artır (60sn -> 120sn -> 180sn)
        // Böylece Math gibi büyük bölümlerde hemen pes etmez.
        const dynamicTimeout = 60000 * attempt; 

        console.log(`⏳ [${dept}] Veri çekiliyor... (Deneme: ${attempt}, Süre Limiti: ${dynamicTimeout/1000}sn)`);

        const response = await axios.post(EXAM_TABLE_URL, `derskod=${dept}`, {
            responseType: 'arraybuffer',
            httpsAgent: agent, // Socket Hang Up önleyici
            maxContentLength: Infinity, // Veri boyutunu sınırlama (Math için gerekli)
            maxBodyLength: Infinity,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': globalCookie,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': DEPT_LIST_URL,
                'Origin': 'https://www.cankaya.edu.tr',
                'Connection': 'keep-alive'
            },
            timeout: dynamicTimeout 
        });
        return response;

    } catch (error) {
        const isSocketError = error.code === 'ECONNRESET' || error.message.includes('socket hang up');
        const isTimeout = error.code === 'ECONNABORTED';

        if (attempt <= MAX_RETRIES) {
            let reason = error.message;
            if (isSocketError) reason = "Sunucu bağlantıyı kesti (Socket Hang Up)";
            if (isTimeout) reason = "Süre yetmedi (Timeout)";

            console.log(`⚠️ [${dept}] Hata: ${reason}. Sabır artırılarak tekrar deneniyor...`);
            
            // Sunucu yorulduysa biraz uzun bekle
            const waitTime = isSocketError ? 15000 : (5000 * attempt);
            await sleep(waitTime); 
            
            return fetchDepartmentWithRetry(dept, attempt + 1);
        } else {
            throw error; // Artık pes et
        }
    }
}

// ADIM 3: Ana İşlem
async function scrapeAndUpload() {
    console.log(`🚀 BAŞLIYORUZ (Güvenli Mod Devrede)...`);

    const departments = await getDepartmentsAndCookie();
    let globalCounter = 1;

    for (const dept of departments) {
        try {
            const response = await fetchDepartmentWithRetry(dept);

            const decodedData = iconv.decode(response.data, 'utf-8');
            const $ = cheerio.load(decodedData);
            const rows = $('table tr'); 
            
            let deptExams = []; 

            rows.each((index, element) => {
                const cols = $(element).find('td');
                if (cols.length >= 6) { 
                    const code = $(cols[0]).text().trim();
                    const date = $(cols[3]).text().trim();

                    if (code && code !== 'Ders Kod' && date.length > 5) {
                        const formattedId = `${dept}-${Date.now()}-${globalCounter}`;
                        
                        let durationData = $(cols[5]).text().trim();
                        
                        // --- HALL (SINIF) DÜZELTMESİ ---
                        // Eğer hücrede <br> varsa onları boşluğa çevir ki yazılar yapışmasın.
                        let hallCell = $(cols[6]);
                        hallCell.find('br').replaceWith(' '); // <br> yerine boşluk koy
                        let hallData = hallCell.text().replace(/\s+/g, ' ').trim(); // Fazla boşlukları temizle
                        // --------------------------------

                        deptExams.push({
                            id: formattedId,
                            code: code,
                            section: $(cols[1]).text().trim(),
                            exam: $(cols[2]).text().trim(),
                            date: date,
                            starting: $(cols[4]).text().trim(),
                            duration: durationData, 
                            hall: hallData // Artık "Amfi1 Amfi2" şeklinde düzgün gelecek
                        });
                        globalCounter++;
                    }
                }
            });

            if (deptExams.length > 0) {
                // Önce bu bölüme ait eski veriyi sil
                const { error: deleteError } = await supabase
                    .from('exams')
                    .delete()
                    .ilike('code', `${dept}%`);

                if (deleteError) {
                    console.error(`❌ [${dept}] Silme hatası:`, deleteError.message);
                    continue;
                }

                // Yeni veriyi ekle
                const { error: insertError } = await supabase.from('exams').insert(deptExams);
                
                if (insertError) {
                    console.error(`❌ [${dept}] Yazma hatası:`, insertError.message);
                } else {
                    console.log(`✅ [${dept}] -> ${deptExams.length} sınav verisi GÜNCELLENDİ.`);
                }
            } else {
                console.log(`⚠️ [${dept}] -> Sınav bulunamadı.`);
            }

            await sleep(SLEEP_TIME);

        } catch (error) {
            console.error(`🔥 [${dept}] KRİTİK HATA: Veri çekilemedi. Eski veri korundu. Sebep:`, error.message);
        }
    }
    console.log("🎉 BÜTÜN İŞLEMLER BAŞARIYLA BİTTİ!");
}

scrapeAndUpload();