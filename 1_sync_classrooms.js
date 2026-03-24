require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');

// --- GÜVENLİK AYARI (DÜZELTİLDİ) ---
const supabaseUrl = process.env.SUPABASE_URL;
// Hem SERVICE_KEY hem de normal KEY'i kontrol eder
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(`❌ Hata: Supabase Bağlantı Bilgileri Eksik! \nURL: ${supabaseUrl ? 'Var' : 'Yok'}\nKEY: ${supabaseKey ? 'Var' : 'Yok'}`);
}

const supabase = createClient(supabaseUrl, supabaseKey);
// ------------------------------------

(async () => {
  const browser = await puppeteer.launch({ 
    headless: "new", 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  const page = await browser.newPage();
  
  console.log('🌍 Siteye gidiliyor...');
  await page.goto('https://dersprog.cankaya.edu.tr/');

  const options = await page.$$eval('#DropDownList1 option', opts => {
    return opts.map(o => o.innerText.trim()).filter(t => t !== "");
  });

  console.log(`📦 Toplam ${options.length} seçenek bulundu.`);

  for (const text of options) {
    if (text.includes('BALGAT') || text.includes('TEST')) {
        continue;
    }

    console.log(`💾 Kaydediliyor: ${text}`);

    const { error } = await supabase
      .from('classrooms')
      .upsert({ room_name: text }, { onConflict: 'room_name' });

    if (error) console.error(`❌ Hata (${text}):`, error.message);
  }

  console.log('✅ Sınıf listesi tamam.');
  await browser.close();
})();