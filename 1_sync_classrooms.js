require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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
    // SADECE BALGAT VE TEST OLANLARI ATLA
    // "Belirsiz" artık serbest
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