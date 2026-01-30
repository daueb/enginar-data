const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- AYARLAR ---
const DEPT_LIST_URL = 'https://www.cankaya.edu.tr/ogrenci_isleri/sinav.php';
const EXAM_TABLE_URL = 'https://www.cankaya.edu.tr/ogrenci_isleri/sinavderskod.php';

// Bekleme Süresi: 5 Saniye (İdeal)
const SLEEP_TIME = 5000; 
// Hata olursa kaç kere tekrar denesin?
const MAX_RETRIES = 3;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let globalCookie = null;

// ADIM 1: Bölümleri ve Çerezi Al
async function getDepartmentsAndCookie() {
    console.log("🔍 Siteye giriş yapılıyor...");
    try {
        const response = await axios.get(DEPT_LIST_URL, { 
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0'
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

// Güvenli İstek Atan Fonksiyon (Retry Mekanizması)
async function fetchDepartmentWithRetry(dept, attempt = 1) {
    try {
        const response = await axios.post(EXAM_TABLE_URL, `derskod=${dept}`, {
            responseType: 'arraybuffer',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': globalCookie,
                'User-Agent': 'Mozilla/5.0',
                'Referer': DEPT_LIST_URL
            },
            timeout: 30000 // 30 saniye cevap gelmezse hata ver
        });
        return response;
    } catch (error) {
        if (attempt <= MAX_RETRIES) {
            console.log(`⚠️ [${dept}] Hata oluştu (${error.message}). ${attempt}. kez tekrar deneniyor...`);
            await sleep(3000 * attempt); // Her denemede biraz daha fazla bekle (3sn, 6sn, 9sn)
            return fetchDepartmentWithRetry(dept, attempt + 1);
        } else {
            throw error; // Artık pes et, hatayı fırlat
        }
    }
}

async function scrapeAndUpload() {
    console.log(`🚀 BAŞLIYORUZ (Güvenli Mod: Hata Olursa Eski Veri Silinmez)...`);
    
    // DİKKAT: Artık en başta tabloyu komple SİLMİYORUZ!
    // const { error: delError } = await supabase.from('exams').delete().neq('id', '0'); <-- BU KALDIRILDI

    const departments = await getDepartmentsAndCookie();
    let globalCounter = 1; // ID üretmek için sayaç (DİKKAT: Bu ID her çalışmada değişebilir ama sorun değil)

    for (const dept of departments) {
        try {
            // 1. Veriyi çekmeye çalış (3 kere dener)
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
                        // ID çakışmasını önlemek için tarih bazlı veya rastgele bir ek yapabiliriz
                        // Ama şimdilik basit sayaç kullanalım, her seferinde sildiğimiz için sorun olmaz
                        const formattedId = `${dept}-${Date.now()}-${globalCounter}`;
                        
                        let durationData = $(cols[5]).text().trim();
                        let hallData = "";
                        if (cols.length > 6) hallData = $(cols[6]).text().replace(/\s+/g, ' ').trim();

                        deptExams.push({
                            id: formattedId,
                            code: code,
                            section: $(cols[1]).text().trim(),
                            exam: $(cols[2]).text().trim(),
                            date: date,
                            starting: $(cols[4]).text().trim(),
                            duration: durationData, 
                            hall: hallData          
                        });
                        globalCounter++;
                    }
                }
            });

            // 2. KRİTİK NOKTA: Veri varsa güncelle, yoksa/hatalıysa dokunma
            if (deptExams.length > 0) {
                // Önce SADECE BU BÖLÜMÜN eski verilerini sil (code sütunu 'MATH' ile başlayanları sil gibi)
                // Not: 'code' sütunu "MATH 101" gibi olduğu için 'MATH%' ile aratıyoruz.
                const { error: deleteError } = await supabase
                    .from('exams')
                    .delete()
                    .ilike('code', `${dept}%`); // Örn: 'MATH%' ile başlayanları sil

                if (deleteError) {
                    console.error(`❌ [${dept}] Eski veriler silinemedi, işlem iptal:`, deleteError.message);
                    continue;
                }

                // Şimdi yenileri ekle
                const { error: insertError } = await supabase.from('exams').insert(deptExams);
                
                if (insertError) {
                    console.error(`❌ [${dept}] Yeni veri yazılamadı:`, insertError.message);
                } else {
                    console.log(`✅ [${dept}] -> ${deptExams.length} sınav GÜNCELLENDİ.`);
                }
            } else {
                console.log(`⚠️ [${dept}] -> Sınav bulunamadı (Eski veri varsa korundu).`);
            }

            await sleep(SLEEP_TIME);

        } catch (error) {
            // Eğer 3 kere denemesine rağmen hala hata alıyorsa buraya düşer
            console.error(`🔥 [${dept}] İFLAS ETTİ: Veri çekilemedi. ESKİ VERİ KORUNDU. Hata:`, error.message);
        }
    }
    console.log("🎉 BÜTÜN İŞLEMLER BİTTİ!");
}

scrapeAndUpload();