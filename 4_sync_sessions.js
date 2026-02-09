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
  
  // Üniversite sayfası yavaş olabildiği için timeout süresini 60 sn yapıyoruz
  await page.setDefaultNavigationTimeout(60000);

  await page.goto('https://dersprog.cankaya.edu.tr/', { waitUntil: 'networkidle2' });

  // Dropdown listesindeki sınıfları al
  const options = await page.$$eval('#DropDownList1 option', opts => opts.map(o => ({ val: o.value, text: o.innerText.trim() })));

  for (const opt of options) {
    // Balgat ve Test kampüslerini filtrele
    if (opt.text.includes('BALGAT') || opt.text.includes('TEST')) continue;

    // 1. Sınıfı DB'den Bul (classrooms tablosu)
    const { data: classData } = await supabase.from('classrooms').select('id').eq('room_name', opt.text).single();
    
    if (!classData) {
        console.log(`⚠️ Sınıf DB'de yok: ${opt.text}`);
        continue;
    }

    console.log(`\n>> Senkronize ediliyor: ${opt.text}`);

    // Mevcut sınıfın eski verilerini temizle (Sync mantığı)
    await supabase.from('course_sessions').delete().eq('classroom_id', classData.id);

    // Sayfa navigasyonu
    try {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'load' }),
            page.select('#DropDownList1', opt.val)
        ]);
    } catch (e) {
        console.log(`! ${opt.text} yüklenirken gecikme oldu, devam ediliyor...`);
    }

    // 2. Tablo Verisini Çek (Puppeteer Evaluate)
    const sessions = await page.evaluate(() => {
        const results = [];
        const rows = Array.from(document.querySelectorAll('#GridView1 tr'));

        for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length < 2) continue;

            const timeText = cells[0].innerText.trim();
            let selectedTime = timeText;
            
            // Saat formatı temizliği
            if (timeText.includes('/')) selectedTime = timeText.split('/')[1].trim();
            else if (timeText.includes('-')) selectedTime = timeText.split('-')[1].trim();

            for (let dayIndex = 1; dayIndex < cells.length; dayIndex++) {
                const content = cells[dayIndex].innerText.trim();
                if (content && content.length > 2) {
                    results.push({
                        day: dayIndex,
                        time: selectedTime,
                        rawContent: content
                    });
                }
            }
        }
        return results;
    });

    // 3. Verileri İşle ve Yaz
    for (const session of sessions) {
        const lines = session.rawContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length < 2) continue;

        const firstLine = lines[0]; // Örn: "CENG 101 1"
        const instructorName = lines[lines.length - 1]; // Karmaşayı çözen: Son satır her zaman hoca adıdır

        const lastSpace = firstLine.lastIndexOf(' ');
        if (lastSpace === -1) continue;

        const code = firstLine.substring(0, lastSpace).trim();
        const section = firstLine.substring(lastSpace + 1).trim();

        // A. Dersi Bul
        const { data: courseData } = await supabase.from('courses').select('id').eq('course_code', code).maybeSingle();

        // B. Eğitmeni Bul (academics tablosu)
        // ilike ve % işareti ile kısmi eşleşme sağlıyoruz (Unvan farkları için)
        const { data: instData } = await supabase
            .from('academics') 
            .select('id')
            .ilike('name', `%${instructorName}%`)
            .maybeSingle();

        if (courseData && instData) {
            const { error: insertError } = await supabase.from('course_sessions').insert({
                course_id: courseData.id,
                classroom_id: classData.id,
                instructor_id: instData.id,
                section: section,
                day_of_week: session.day,
                time: session.time
            });

            if (insertError) console.log(`❌ Hata (${code}): ${insertError.message}`);
            else console.log(`✅ ${code} (${section}) -> ${instructorName}`);
        } else {
            // Neden bulunamadığını konsola detaylı yazdır (Debug için)
            if (!courseData) console.log(`❓ Ders DB'de yok: "${code}"`);
            if (!instData) console.log(`❓ Eğitmen DB'de yok: "${instructorName}"`);
        }
    }
    
    await delay(300); // DB'yi yormamak için kısa bekleme
  }

  console.log('\n🚀 Unibee Senkronizasyonu Başarıyla Tamamlandı!');
  await browser.close();
})();