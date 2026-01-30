const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- AYARLAR ---
const CALENDAR_URL = 'https://www.cankaya.edu.tr/akademik_takvim/index.php';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function scrapeCalendar() {
    console.log("📅 Akademik Takvim Taraması (Sadeleştirilmiş Mod)...");
    
    // Tabloyu temizle
    await supabase.from('academic_calendar').delete().neq('id', '0');
    
    try {
        const response = await axios.get(CALENDAR_URL, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const decodedData = iconv.decode(response.data, 'utf-8');
        const $ = cheerio.load(decodedData);

        let calendarData = [];
        let globalCounter = 1;

        let currentSchoolType = "GENEL TAKVİM"; 
        let currentTerm = "GENEL DÖNEM";

        $('table tr').each((index, element) => {
            
            const rawText = $(element).text().replace(/\s+/g, ' ').trim();
            const upperText = rawText.toUpperCase();
            const cols = $(element).find('td');

            // 1. OKUL TÜRÜ KONTROLÜ
            if (upperText.includes("AKADEMİK TAKVİMİ") && !upperText.includes("ÖĞRETİM YILI")) {
                currentSchoolType = rawText.replace(/AKADEMİK TAKVİMİ/gi, "").trim();
                if (currentSchoolType === "") currentSchoolType = "AKADEMİK TAKVİM";
                console.log(`📌 Okul Türü: ${currentSchoolType}`);
            }

            // 2. DÖNEM KONTROLÜ (50 karakterden kısaysa başlıktır)
            else if ((upperText.includes("YARIYILI") || upperText.includes("YAZ ÖĞRETİMİ")) && rawText.length < 50) {
                currentTerm = rawText; 
                console.log(`   👉 Dönem: ${currentTerm}`);
            }

            // 3. VERİ KONTROLÜ
            else if (cols.length >= 2) {
                const rawDate = $(cols[0]).text().trim();
                const description = $(cols[1]).text().trim();

                // Filtreler: Boş olmasın, başlık olmasın, çok kısa olmasın
                if (rawDate && description && rawDate !== "TARİH" && rawDate.length > 3) {
                    
                    const formattedId = `calendar-${String(globalCounter).padStart(4, '0')}`;
                    
                    calendarData.push({
                        id: formattedId,
                        school_type: currentSchoolType,
                        term: currentTerm,
                        date: rawDate,         // DİREKT SİTEDEKİ HALİ
                        description: description
                    });
                    globalCounter++;
                }
            }
        });

        // Veritabanına Yaz
        if (calendarData.length > 0) {
            console.log(`💾 Toplam ${calendarData.length} kayıt bulundu.`);
            
            for (let i = 0; i < calendarData.length; i += 100) {
                const chunk = calendarData.slice(i, i + 100);
                const { error } = await supabase.from('academic_calendar').insert(chunk);
                if (error) console.error("Hata:", error);
            }
            console.log("🎉 TAKVİM GÜNCELLENDİ (date_text kaldırıldı).");
        } else {
            console.log("⚠️ Veri bulunamadı.");
        }

    } catch (error) {
        console.error("❌ Hata:", error.message);
    }
}

scrapeCalendar();