require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer');

// --- GÜVENLİK AYARI (DÜZELTİLDİ) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("❌ Hata: Supabase URL veya Key eksik!");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

(async () => {
  const browser = await puppeteer.launch({ 
    headless: "new", 
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  const page = await browser.newPage();
  await page.goto('https://dersprog.cankaya.edu.tr/');

  const options = await page.$$eval('#DropDownList1 option', opts => opts.map(o => ({ val: o.value, text: o.innerText })));
  const seenAcademics = new Set();

  for (const opt of options) {
    if (opt.text.includes('BALGAT') || opt.text.includes('TEST')) continue;

    console.log(`>> Taranıyor: ${opt.text}`);
    
    await page.select('#DropDownList1', opt.val);
    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    const cellData = await page.$$eval('#GridView1 tr td', tds => tds.map(td => td.innerText.trim()));

    for (const text of cellData) {
      const lines = text.split('\n');
      if (lines.length > 1) {
        const academicName = lines[lines.length - 1].trim();
        
        if (academicName && !seenAcademics.has(academicName) && academicName.length > 3) {
            seenAcademics.add(academicName);
            
            const { data } = await supabase.from('academics').select('id').eq('name', academicName).maybeSingle();
            
            if (!data) {
                console.log(`➕ Yeni Hoca: ${academicName}`);
                await supabase.from('academics').insert({ name: academicName });
            }
        }
      }
    }
    await delay(500);
  }

  await browser.close();
})();