require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

(async () => {
  const browser = await puppeteer.launch({ 
  headless: "new", 
  args: ['--no-sandbox', '--disable-setuid-sandbox'] 
});
  const page = await browser.newPage();
  
  console.log('🌍 Ders listesi taranıyor...');
  await page.goto('https://dersprog.cankaya.edu.tr/');

  const options = await page.$$eval('#DropDownList1 option', opts => opts.map(o => ({ val: o.value, text: o.innerText })));

  let totalFound = 0; // Kaç ders bulduğumuzu sayalım

  for (const opt of options) {
    // FİLTRE: Balgat ve Test hariç, Belirsizler dahil.
    if (opt.text.includes('BALGAT') || opt.text.includes('TEST')) {
        continue;
    }

    console.log(`>> Taranıyor: ${opt.text}`); // Hangi sınıfa/bölüme baktığımızı görelim

    // Sayfaya git
    await page.select('#DropDownList1', opt.val);
    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    // Tablodaki hücreleri al
    const cellData = await page.$$eval('#GridView1 tr td', tds => tds.map(td => td.innerText.trim()));

    for (const text of cellData) {
        const lines = text.split('\n');
        if (lines.length > 0) {
            // Örn: "MATH 157 1" -> Son boşluktan öncesi KOD
            const firstLine = lines[0].trim();
            const lastSpaceIndex = firstLine.lastIndexOf(' ');
            
            if (lastSpaceIndex !== -1) {
                const courseCode = firstLine.substring(0, lastSpaceIndex).trim();
                
                // Supabase'e Yaz
                const { error } = await supabase.from('courses').upsert({
                    course_code: courseCode
                }, { onConflict: 'course_code' });
                
                if (!error) {
                    totalFound++;
                    // İŞTE BURASI: Terminalde dersi gösteriyoruz
                    console.log(`   ✅ [${totalFound}] Ders Eklendi: ${courseCode}`);
                } else {
                    console.log(`   ❌ Hata (${courseCode}):`, error.message);
                }
            }
        }
    }
    // Her sayfa geçişinde azıcık bekle
    await delay(200);
  }
  
  console.log(`🎉 İşlem Tamamlandı! Toplam ${totalFound} ders işlendi.`);
  await browser.close();
})();