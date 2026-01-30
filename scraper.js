//scraper.js

const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- AYARLAR ---
const DEPT_LIST_URL = 'https://www.cankaya.edu.tr/ogrenci_isleri/sinav.php';
const EXAM_TABLE_URL = 'https://www.cankaya.edu.tr/ogrenci_isleri/sinavderskod.php';
const SLEEP_TIME = 5000; // 5 Saniye bekleme (Saldırı algılanmaması için)

// GitHub Secrets'tan veya .env'den al
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
                // Sütun sayısı kontrolü
                if (cols.length >= 6) { 
                    const code = $(cols[0]).text().trim();
                    const date = $(cols[3]).text().trim();

                    // Geçerli bir sınav satırı mı?
                    if (code && code !== 'Ders Kod' && date.length > 5) {
                        const formattedId = `Exam-${String(globalCounter).padStart(5, '0')}`;
                        
                        // DÜZELTME BURADA YAPILDI:
                        // Tablo: 0:Kod, 1:Grup, 2:Sınav, 3:Tarih, 4:Saat, 5:Süre, 6:Derslik
                        
                        let durationData = $(cols[5]).text().trim(); // SÜRE (Col 5)
                        let hallData = "";
                        
                        if (cols.length > 6) {
                             hallData = $(cols[6]).text().replace(/\s+/g, ' ').trim(); // DERSLİK (Col 6)
                        }

                        deptExams.push({
                            id: formattedId,
                            code: code,
                            section: $(cols[1]).text().trim(),
                            exam: $(cols[2]).text().trim(),
                            date: date,
                            starting: $(cols[4]).text().trim(),
                            duration: durationData, // Artık doğru sütun
                            hall: hallData          // Artık doğru sütun
                        });
                        globalCounter++;
                    }
                }
            });

            // Veritabanına Yaz
            if (deptExams.length > 0) {
                const { error } = await supabase.from('exams').insert(deptExams);
                
                if (error) {
                    console.error(`❌ [${dept}] Veritabanı Hatası:`, error.message);
                } else {
                    console.log(`✅ [${dept}] -> ${deptExams.length} sınav YÜKLENDİ.`);
                }
            } else {
                console.log(`⚠️ [${dept}] -> 0 sınav.`);
            }

            // Bekleme Süresi (5 Saniye)
            await sleep(SLEEP_TIME);

        } catch (error) {
            console.error(`❌ [${dept}] Ağ Hatası:`, error.message);
        }
    }

    console.log("🎉 BÜTÜN İŞLEMLER BİTTİ!");
}

scrapeAndUpload();
