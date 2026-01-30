//calendar_scraper.js

const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// --- AYARLAR ---
const CALENDAR_URL = 'https://www.cankaya.edu.tr/akademik_takvim/index.php';

// DÜZELTME: Hem SUPABASE_KEY hem de SERVICE_KEY kabul etsin
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Hata: Supabase URL veya Key eksik!");
    // GitHub Actions'da hata fırlatmaması için (sessizce bitsin istersen) veya process.exit(1) diyebilirsin.
    // Şimdilik process.exit(1) diyelim ki logda görelim.
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function scrapeCalendar() {
    console.log("📅 Akademik Takvim Taraması...");
    
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

            // 2. DÖNEM KONTROLÜ
            else if ((upperText.includes("YARIYILI") || upperText.includes("YAZ ÖĞRETİMİ")) && rawText.length < 50) {
                currentTerm = rawText; 
                console.log(`   👉 Dönem: ${currentTerm}`);
            }

            // 3. VERİ KONTROLÜ
            else if (cols.length >= 2) {
                const rawDate = $(cols[0]).text().trim();
                const description = $(cols[1]).text().trim();

                if (rawDate && description && rawDate !== "TARİH" && rawDate.length > 3) {
                    
                    const formattedId = `calendar-${String(globalCounter).padStart(4, '0')}`;
                    
                    calendarData.push({
                        id: formattedId,
                        school_type: currentSchoolType,
                        term: currentTerm,
                        date: rawDate,
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
            console.log("🎉 TAKVİM GÜNCELLENDİ.");
        } else {
            console.log("⚠️ Veri bulunamadı.");
        }

    } catch (error) {
        console.error("❌ Hata:", error.message);
        process.exit(1);
    }
}

scrapeCalendar();