const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- AYARLAR ---
const DEPT_LIST_URL = 'https://www.cankaya.edu.tr/ogrenci_isleri/sinav.php';
const EXAM_TABLE_URL = 'https://www.cankaya.edu.tr/ogrenci_isleri/sinavderskod.php';
const SLEEP_TIME = 3000; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let globalCookie = null;

// ADIM 1: Bölümleri ve Çerezi Al
async function getDepartmentsAndCookie() {
    console.log("🔍 Siteye giriş yapılıyor...");
    try {
        const response = await axios.get(DEPT_LIST_URL, { 
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        
        // Çerezi kap (Oturum açmak için şart)
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

async function scrapeAndUpload() {
    console.log("🚀 BAŞLIYORUZ (Canlı Kayıt Modu)...");
    
    // Temiz başlangıç: Önce eski tabloyu boşaltalım
    console.log("🧹 Tablo temizleniyor...");
    const { error: delError } = await supabase.from('exams').delete().neq('id', '0');
    if (delError) console.error("Silme hatası:", delError);
    else console.log("🗑️ Tablo temizlendi.");

    const departments = await getDepartmentsAndCookie();
    let globalCounter = 1;

    for (const dept of departments) {
        try {
            const response = await axios.post(EXAM_TABLE_URL, `derskod=${dept}`, {
                responseType: 'arraybuffer',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': globalCookie,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': DEPT_LIST_URL
                }
            });

            const decodedData = iconv.decode(response.data, 'utf-8');
            const $ = cheerio.load(decodedData);
            const rows = $('table tr'); 
            
            let deptExams = []; // Sadece bu bölümün sınavları

            rows.each((index, element) => {
                const cols = $(element).find('td');
                if (cols.length >= 5) {
                    const code = $(cols[0]).text().trim();
                    const date = $(cols[3]).text().trim();

                    // Geçerli bir sınav satırı mı?
                    if (code && code !== 'Ders Kod' && date.length > 5) {
                        const formattedId = `Exam-${String(globalCounter).padStart(5, '0')}`;
                        
                        let hall = "";
                        if (cols.length > 5) hall = $(cols[5]).text().replace(/\s+/g, ' ').trim();

                        deptExams.push({
                            id: formattedId,
                            code: code,
                            section: $(cols[1]).text().trim(),
                            exam: $(cols[2]).text().trim(),
                            duration: "",
                            date: date,
                            starting: $(cols[4]).text().trim(),
                            hall: hall
                        });
                        globalCounter++;
                    }
                }
            });

            // --- KRİTİK NOKTA: BULDUĞUNU ANINDA YAZ ---
            if (deptExams.length > 0) {
                const { error } = await supabase.from('exams').insert(deptExams);
                
                if (error) {
                    console.error(`❌ [${dept}] Veritabanı Hatası:`, error.message);
                } else {
                    console.log(`✅ [${dept}] -> ${deptExams.length} sınav bulundu ve YÜKLENDİ.`);
                }
            } else {
                // Sınav yoksa bile ekrana yaz ki çalıştığını görelim
                console.log(`⚠️ [${dept}] -> 0 sınav.`);
            }

            // Hızlıca diğer bölüme geç (Beklemeyi azalttım, istersen arttır)
            await sleep(1000);

        } catch (error) {
            console.error(`❌ [${dept}] Ağ Hatası:`, error.message);
        }
    }

    console.log("🎉 BÜTÜN İŞLEMLER BİTTİ!");
}

scrapeAndUpload();