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
  await page.goto('https://dersprog.cankaya.edu.tr/');

  const options = await page.$$eval('#DropDownList1 option', opts => opts.map(o => ({ val: o.value, text: o.innerText })));

  // Set kullanarak aynı hocayı tekrar tekrar eklemeyi önleyelim (RAM'de tutuyoruz şimdilik)
  const seenAcademics = new Set();

  for (const opt of options) {
    if (opt.text.includes('BALGAT') || opt.text.includes('TEST')) continue;

    console.log(`>> Taranıyor: ${opt.text}`);
    
    // Sayfayı değiştir (PostBack tetikler)
    await page.select('#DropDownList1', opt.val);
    await page.waitForNavigation({ waitUntil: 'networkidle0' }); // Yüklenmesini bekle

    // Tablodaki hücreleri al
    const cellData = await page.$$eval('#GridView1 tr td', tds => tds.map(td => td.innerText.trim()));

    for (const text of cellData) {
      // Format: "KOD SECTION \n HOCA ADI"
      const lines = text.split('\n');
      if (lines.length > 1) {
        const academicName = lines[lines.length - 1].trim(); // Genelde son satır hocadır
        
        // Boş değilse ve daha önce görmediysek ekle
        if (academicName && !seenAcademics.has(academicName) && academicName.length > 3) {
            seenAcademics.add(academicName);
            
            // Veritabanına yaz
            // Not: Academics tablosunda 'name' alanı unique değilse çift kayıt olabilir.
            // Bu yüzden önce kontrol edip yoksa eklemek daha güvenlidir.
            const { data } = await supabase.from('academics').select('id').eq('name', academicName).maybeSingle();
            
            if (!data) {
                console.log(`➕ Yeni Hoca: ${academicName}`);
                await supabase.from('academics').insert({ name: academicName });
            }
        }
      }
    }
    await delay(500); // 0.5 saniye bekle
  }

  await browser.close();
})();