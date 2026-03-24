require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

// --- GÜVENLİK AYARI ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error("❌ Hata: Supabase URL veya Key eksik!");
}
if (!GEMINI_API_KEY) {
    console.warn("⚠️ UYARI: GEMINI_API_KEY eksik! Embedding olmadan devam edilecek (chunk'lar embedding'siz kaydedilecek).");
    console.warn("   Embedding icin: https://aistudio.google.com/apikey adresinden ucretsiz al.");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));
function smartDelay(baseMs = 500) {
    const jitter = baseMs * 0.4 * (Math.random() * 2 - 1);
    return delay(Math.max(200, Math.round(baseMs + jitter)));
}

// --- AYARLAR ---
const MAX_DEPTH = 10;             // Link takip derinliği (10 seviye — derin dokümanları da yakala)
const MAX_PAGES_PER_DOMAIN = 300; // Her subdomain için max sayfa (artırıldı)
const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20MB
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

// =====================================================
// KVKK / KİŞİSEL VERİ FİLTRESİ
// =====================================================
// Telefon numaraları (Türkiye formatları)
const PHONE_REGEX = /(\+?90[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|0\d{3}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})/g;
// E-posta adresleri
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
// TC Kimlik numarası (11 haneli)
const TC_REGEX = /\b[1-9]\d{10}\b/g;

function sanitizePersonalData(text) {
    return text
        .replace(PHONE_REGEX, '[TELEFON]')
        .replace(EMAIL_REGEX, '[E-POSTA]')
        .replace(TC_REGEX, '[TC-NO]');
}

// =====================================================
// OTOMATİK SUBDOMAİN KEŞFİ (crt.sh)
// =====================================================
async function discoverSubdomains() {
    console.log('🔍 crt.sh üzerinden tüm subdomain\'ler keşfediliyor...');

    try {
        const res = await axios.get('https://crt.sh/?q=%.cankaya.edu.tr&output=json', {
            timeout: 30000
        });

        const subdomains = new Set();
        for (const cert of res.data) {
            const names = (cert.name_value || '').split('\n');
            for (const name of names) {
                const clean = name.trim().replace(/^\*\./, '');
                if (clean.endsWith('cankaya.edu.tr') && !clean.includes('*')) {
                    subdomains.add(clean);
                }
            }
        }

        console.log(`   📡 crt.sh'den ${subdomains.size} benzersiz subdomain bulundu`);
        return [...subdomains];
    } catch (err) {
        console.error('   ⚠️ crt.sh erişilemedi, yedek listeye geçiliyor:', err.message);
        return null; // Yedek listeye düşecek
    }
}

// Yedek sabit liste (crt.sh çalışmazsa) — 6b_crawl_missing.js ile birleştirildi
const FALLBACK_SUBDOMAINS = [
    // Ana site
    'cankaya.edu.tr', 'www.cankaya.edu.tr',
    // Öğrenci hizmetleri
    'oim.cankaya.edu.tr', 'oidb.cankaya.edu.tr', 'registrar.cankaya.edu.tr',
    'kutuphane.cankaya.edu.tr', 'spor.cankaya.edu.tr', 'saglik.cankaya.edu.tr',
    'pdrm.cankaya.edu.tr', 'sks.cankaya.edu.tr', 'kariyer.cankaya.edu.tr',
    // Uluslararası
    'iro.cankaya.edu.tr', 'erasmus.cankaya.edu.tr', 'mevlana.cankaya.edu.tr',
    // Fakülte ana sayfaları
    'muhf.cankaya.edu.tr', 'fef.cankaya.edu.tr', 'iibf.cankaya.edu.tr',
    'mimarlik.cankaya.edu.tr', 'hukuk.cankaya.edu.tr',
    // İdari birimler
    'kalite.cankaya.edu.tr', 'cc.cankaya.edu.tr',
    'odekan.cankaya.edu.tr', 'rektorluk.cankaya.edu.tr',
    'genelsekreterlik.cankaya.edu.tr', 'bim.cankaya.edu.tr',
    'kariyermezun.cankaya.edu.tr', 'kst.cankaya.edu.tr',
    'kultur.cankaya.edu.tr', 'yurt.cankaya.edu.tr',
    // Mühendislik Fakültesi bölümleri
    'ceng.cankaya.edu.tr', 'me.cankaya.edu.tr', 'ce.cankaya.edu.tr',
    'ee.cankaya.edu.tr', 'eee.cankaya.edu.tr', 'ie.cankaya.edu.tr',
    'ece.cankaya.edu.tr', 'mece.cankaya.edu.tr', 'mse.cankaya.edu.tr',
    'yazilim.cankaya.edu.tr', 'malzeme.cankaya.edu.tr',
    'en.ceng.cankaya.edu.tr', 'en.me.cankaya.edu.tr', 'en.ce.cankaya.edu.tr',
    'en.ee.cankaya.edu.tr', 'en.ie.cankaya.edu.tr', 'en.ece.cankaya.edu.tr',
    'en.mece.cankaya.edu.tr',
    // Fen-Edebiyat Fakültesi bölümleri
    'math.cankaya.edu.tr', 'ell.cankaya.edu.tr', 'psy.cankaya.edu.tr',
    'mtb.cankaya.edu.tr', 'bb.cankaya.edu.tr',
    'en.math.cankaya.edu.tr', 'en.ell.cankaya.edu.tr', 'en.psy.cankaya.edu.tr',
    'en.mtb.cankaya.edu.tr', 'en.bb.cankaya.edu.tr',
    // İktisadi ve İdari Bilimler Fakültesi bölümleri
    'econ.cankaya.edu.tr', 'iktisat.cankaya.edu.tr', 'ir.cankaya.edu.tr',
    'man.cankaya.edu.tr', 'bf.cankaya.edu.tr', 'psi.cankaya.edu.tr',
    'economics.cankaya.edu.tr', 'sbu.cankaya.edu.tr', 'intt.cankaya.edu.tr',
    'hir.cankaya.edu.tr', 'mis.cankaya.edu.tr',
    'en.econ.cankaya.edu.tr', 'en.man.cankaya.edu.tr', 'en.bf.cankaya.edu.tr',
    // Hukuk
    'law.cankaya.edu.tr', 'fld.cankaya.edu.tr',
    // Mimarlık Fakültesi bölümleri
    'arch.cankaya.edu.tr', 'architecture.cankaya.edu.tr',
    'id.cankaya.edu.tr', 'inar.cankaya.edu.tr', 'crp.cankaya.edu.tr',
    'en.inar.cankaya.edu.tr',
    // Enstitüler ve Yüksekokullar
    'gs.cankaya.edu.tr', 'sbe.cankaya.edu.tr', 'fbe.cankaya.edu.tr',
    'lee.cankaya.edu.tr', 'adalet.cankaya.edu.tr', 'myo.cankaya.edu.tr',
    'en.sbe.cankaya.edu.tr', 'en.gs.cankaya.edu.tr', 'en.fbe.cankaya.edu.tr',
    // Ders siteleri
    'ce102.cankaya.edu.tr', 'math111.cankaya.edu.tr', 'math112.cankaya.edu.tr',
    'math103.cankaya.edu.tr', 'ell114.cankaya.edu.tr',
    'psi101.cankaya.edu.tr', 'psi102.cankaya.edu.tr', 'psi103.cankaya.edu.tr',
    'psi203.cankaya.edu.tr', 'psi303.cankaya.edu.tr', 'psi412.cankaya.edu.tr',
    'ece329.cankaya.edu.tr', 'me416.cankaya.edu.tr', 'me626.cankaya.edu.tr',
    'mest.cankaya.edu.tr',
    'mse235.cankaya.edu.tr', 'mse226.cankaya.edu.tr', 'mse206.cankaya.edu.tr',
    'mse302.cankaya.edu.tr', 'mse225.cankaya.edu.tr',
    'inar384.cankaya.edu.tr', 'inar357.cankaya.edu.tr', 'inar121.cankaya.edu.tr',
    // Portal/sistem
    'webonline.cankaya.edu.tr', 'sql.cankaya.edu.tr', 'onbasvuru.cankaya.edu.tr',
];

// Atlanacak subdomain'ler (login gerekli, boş, veya faydasız)
const SKIP_SUBDOMAINS = new Set([
    'mail.cankaya.edu.tr',
    'webmail.cankaya.edu.tr',
    'vpn.cankaya.edu.tr',
    'sql.cankaya.edu.tr',       // Öğrenci bilgi sistemi (login)
    'webonline.cankaya.edu.tr', // Personel sistemi (login)
    'onbasvuru.cankaya.edu.tr', // Başvuru sistemi (login)
    'moodle.cankaya.edu.tr',    // LMS (login)
    'lms.cankaya.edu.tr',
    'portal.cankaya.edu.tr',
    'autodiscover.cankaya.edu.tr',
    'ftp.cankaya.edu.tr',
    'ns1.cankaya.edu.tr',
    'ns2.cankaya.edu.tr',
    'dns.cankaya.edu.tr',
    'mx.cankaya.edu.tr',
    'smtp.cankaya.edu.tr',
    'pop.cankaya.edu.tr',
    'imap.cankaya.edu.tr',
]);

// =====================================================
// ÖNCELİKLİ URL'LER — Öğrencilerin en çok soracağı sayfalar
// Bu URL'ler crawl sırasında ilk taranır ve derinlemesine inilir
// =====================================================
const PRIORITY_URLS = [
    // Yönetmelikler & Yönergeler
    'https://oim.cankaya.edu.tr/box/yonetmelik-ve-yonergeler/',
    'https://oim.cankaya.edu.tr/',
    'https://kutuphane.cankaya.edu.tr/yonetmelikler/',
    'https://kutuphane.cankaya.edu.tr/yonetmelikler-ve-yonergeler/',
    'https://fbe.cankaya.edu.tr/yonetmelikler/',
    'https://sbe.cankaya.edu.tr/yonetmelikler/',
    // Öğrenci İşleri
    'https://www.cankaya.edu.tr/universite/ogrenci-isleri-iletisim.php',
    'https://oim.cankaya.edu.tr/box/ogrenci-bilgi-sistemi/',
    'https://oim.cankaya.edu.tr/box/uluslararasi-ogrenci/',
    // Akademik bilgiler
    'https://www.cankaya.edu.tr/akademik/',
    'https://www.cankaya.edu.tr/universite/',
    'https://www.cankaya.edu.tr/universite/idari.php',
    'https://www.cankaya.edu.tr/universite/rektor.php',
    // Kütüphane rehberleri
    'https://kutuphane.cankaya.edu.tr/on-lisans-ve-lisans-ogrencileri-icin-rehber/',
    'https://kutuphane.cankaya.edu.tr/yl-dr-ogrenci/',
    // Erasmus / Uluslararası
    'https://iro.cankaya.edu.tr/',
    'https://erasmus.cankaya.edu.tr/',
    // Sağlık
    'https://saglik.cankaya.edu.tr/',
    'https://saglik.cankaya.edu.tr/ogrenci-rapor-islemleri/',
    'https://saglik.cankaya.edu.tr/box/yonetmelik/',
    // Kariyer
    'https://kariyer.cankaya.edu.tr/',
    // Enstitüler
    'https://fbe.cankaya.edu.tr/',
    'https://sbe.cankaya.edu.tr/',
    'https://gs.cankaya.edu.tr/',
    // Kalite - öğrenciye yararlı olanlar
    'https://kalite.cankaya.edu.tr/',
];

// Dosya uzantıları
const SKIP_EXTENSIONS = /\.(jpg|jpeg|png|gif|svg|webp|ico|bmp|tiff|mp4|mp3|wav|avi|mov|zip|rar|7z|tar|gz|exe|dmg|msi|css|woff|woff2|ttf|eot)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const OFFICE_EXTENSIONS = /\.(doc|docx|xls|xlsx|ppt|pptx)$/i;
const JS_EXTENSION = /\.js$/i;

// =====================================================
// EMBEDDING FONKSİYONU (Google Gemini - Ucretsiz, 768 boyut)
// =====================================================
// Embedding rate limiter: Gemini free tier = 1000 req/dakika
let embedRequestCount = 0;
let embedMinuteStart = Date.now();
const MAX_EMBEDS_PER_MINUTE = 900; // 1000 limitin altinda kal

// Ardışık hata sayacı: üst üste 3 quota hatası → embedding tamamen kapat
let consecutiveEmbedFailures = 0;
let embeddingDisabled = false;
let successfulEmbeddings = 0;
let skippedEmbeddings = 0;

async function getEmbedding(text, retryCount = 0) {
    if (!GEMINI_API_KEY) return null;
    if (embeddingDisabled) {
        skippedEmbeddings++;
        return null;
    }

    // Rate limiting: dakikada max 900 istek
    embedRequestCount++;
    const elapsed = Date.now() - embedMinuteStart;
    if (elapsed >= 60000) {
        embedRequestCount = 1;
        embedMinuteStart = Date.now();
    } else if (embedRequestCount >= MAX_EMBEDS_PER_MINUTE) {
        const waitMs = 60000 - elapsed + 2000;
        console.log(`   ⏳ Embedding rate limit: ${Math.round(waitMs/1000)}sn bekleniyor...`);
        await delay(waitMs);
        embedRequestCount = 1;
        embedMinuteStart = Date.now();
    }

    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
            {
                content: { parts: [{ text: text.substring(0, 8000) }] },
                outputDimensionality: 768
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        consecutiveEmbedFailures = 0; // Başarılı → sıfırla
        successfulEmbeddings++;
        return res.data.embedding.values;
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        // Quota/rate limit hatasi: bekle ve tekrar dene (max 3 deneme)
        if (msg.includes('Quota exceeded') || msg.includes('RATE_LIMIT') || err.response?.status === 429) {
            if (retryCount < 2) {
                // İlk denemede kısa bekle, uzun bekleme yapma
                const waitSec = retryCount === 0 ? 5 : 10;
                console.log(`   ⏳ Embedding quota - ${waitSec}sn bekleniyor (deneme ${retryCount + 1}/2)...`);
                await delay(waitSec * 1000);
                embedRequestCount = 0;
                embedMinuteStart = Date.now();
                return getEmbedding(text, retryCount + 1);
            }
            consecutiveEmbedFailures++;
            if (consecutiveEmbedFailures >= 3) {
                console.warn('⚠️ ═══════════════════════════════════════════════════');
                console.warn('⚠️ Embedding kotası tükendi! Geri kalan chunk\'lar embedding\'siz kaydedilecek.');
                console.warn('⚠️ Kota yenilenince "Vectorize" job\'ını tekrar çalıştırarak embedding ekleyebilirsin.');
                console.warn('⚠️ ═══════════════════════════════════════════════════');
                embeddingDisabled = true;
                skippedEmbeddings++;
            } else {
                console.warn(`⚠️ Embedding başarısız (ardışık hata: ${consecutiveEmbedFailures}/3)`);
            }
            return null;
        }
        console.error('❌ Embedding hatası:', msg);
        return null;
    }
}

// =====================================================
// TEXT CHUNKING
// =====================================================
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    if (!text || text.length < 50) return [];
    const words = text.split(/\s+/);
    const chunks = [];
    let start = 0;
    while (start < words.length) {
        const end = Math.min(start + chunkSize, words.length);
        const chunk = words.slice(start, end).join(' ');
        if (chunk.length > 30) chunks.push(chunk);
        start += chunkSize - overlap;
    }
    return chunks;
}

// =====================================================
// HTML → TEMİZ METİN
// =====================================================
function htmlToText(html) {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, iframe, noscript, .menu, .sidebar, .navigation, .breadcrumb, .cookie-banner').remove();
    let text = $('body').text() || $.text();
    text = text
        .replace(/\t/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/ {2,}/g, ' ')
        .trim();
    // KVKK: Kişisel verileri maskele
    text = sanitizePersonalData(text);
    return text;
}

// =====================================================
// SAYFA CRAWL (HTML)
// =====================================================
async function fetchPage(url) {
    try {
        const res = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
            },
            maxRedirects: 3,
            responseType: 'text'
        });
        const contentType = res.headers['content-type'] || '';
        if (!contentType.includes('text/html')) return null;
        return res.data;
    } catch (err) {
        return null;
    }
}

// =====================================================
// PDF İNDİR + METİN ÇIKAR
// =====================================================
async function fetchAndParsePdf(url) {
    try {
        const res = await axios.get(url, {
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
            responseType: 'arraybuffer',
            maxContentLength: MAX_PDF_SIZE,
            maxRedirects: 3
        });

        const buffer = Buffer.from(res.data);
        const pdf = await pdfParse(buffer);

        let text = (pdf.text || '')
            .replace(/\t/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/ {2,}/g, ' ')
            .trim();

        // KVKK: Kişisel verileri maskele
        text = sanitizePersonalData(text);

        const title = pdf.info?.Title || decodeURIComponent(url.split('/').pop().replace('.pdf', '')) || 'PDF Document';
        return { text, title, pages: pdf.numpages || 0 };
    } catch (err) {
        if (err.response?.status === 404) return null;
        console.error(`   ⚠️ PDF okunamadı (${url.split('/').pop()}): ${err.message}`);
        return null;
    }
}

// =====================================================
// OFFICE DOSYALARI PARSE (docx, xlsx, pptx)
// =====================================================
async function fetchAndParseOffice(url) {
    try {
        const res = await axios.get(url, {
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
            responseType: 'arraybuffer',
            maxContentLength: MAX_PDF_SIZE,
            maxRedirects: 3
        });

        const buffer = Buffer.from(res.data);
        const ext = url.split('.').pop().toLowerCase().split('?')[0];
        let text = '';
        let title = decodeURIComponent(url.split('/').pop().replace(/\.[^.]+$/, '')) || 'Office Document';

        if (ext === 'docx' || ext === 'doc') {
            try {
                const result = await mammoth.extractRawText({ buffer });
                text = result.value || '';
            } catch {
                // doc (eski format) mammoth ile açılmayabilir
                text = '';
            }
        } else if (ext === 'xlsx' || ext === 'xls') {
            try {
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const parts = [];
                for (const sheetName of workbook.SheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    const csv = XLSX.utils.sheet_to_csv(sheet);
                    if (csv.trim()) parts.push(`[Sayfa: ${sheetName}]\n${csv}`);
                }
                text = parts.join('\n\n');
            } catch {
                text = '';
            }
        } else if (ext === 'pptx' || ext === 'ppt') {
            // pptx basit XML parse — mammoth desteklemez
            // Sadece text içeriğini çıkarmaya çalış
            try {
                const JSZip = require('jszip');
                const zip = await JSZip.loadAsync(buffer);
                const parts = [];
                const slideFiles = Object.keys(zip.files).filter(f => f.startsWith('ppt/slides/slide') && f.endsWith('.xml'));
                for (const slideFile of slideFiles.sort()) {
                    const content = await zip.files[slideFile].async('text');
                    // XML tag'lerini temizle, sadece text'i al
                    const slideText = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    if (slideText.length > 20) parts.push(slideText);
                }
                text = parts.join('\n\n');
            } catch {
                text = '';
            }
        }

        text = sanitizePersonalData(text.replace(/\s+/g, ' ').trim());
        if (text.length < 50) return null;
        return { text, title, type: ext };
    } catch (err) {
        if (err.response?.status === 404) return null;
        console.error(`   ⚠️ Office dosyası okunamadı (${url.split('/').pop()}): ${err.message}`);
        return null;
    }
}

// =====================================================
// LINK ÇIKARMA (HTML + PDF + Office ayrı)
// =====================================================
function extractLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const htmlLinks = new Set();
    const pdfLinks = new Set();
    const baseHost = new URL(baseUrl).hostname;

    const officeLinks = new Set();

    $('a[href]').each((_, el) => {
        let href = $(el).attr('href');
        if (!href) return;
        if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        if (SKIP_EXTENSIONS.test(href)) return;

        try {
            const fullUrl = new URL(href, baseUrl);
            const isSameDomain = fullUrl.hostname === baseHost;
            const isCankayaDomain = fullUrl.hostname.endsWith('cankaya.edu.tr');

            if ((isSameDomain || isCankayaDomain) && fullUrl.protocol.startsWith('http')) {
                fullUrl.hash = '';
                if (PDF_EXTENSION.test(fullUrl.pathname)) {
                    pdfLinks.add(fullUrl.href);
                } else if (OFFICE_EXTENSIONS.test(fullUrl.pathname)) {
                    officeLinks.add(fullUrl.href);
                } else if (isSameDomain) {
                    htmlLinks.add(fullUrl.href);
                }
            }
        } catch { /* geçersiz URL */ }
    });

    return { htmlLinks, pdfLinks, officeLinks };
}

// =====================================================
// RAG SOURCE KAYDI
// Gerçek tablo: id (uuid), title (text), source_type (text), url (text), category (text), department_id (uuid)
// =====================================================
async function ensureRagSource(domain) {
    const { data: existing } = await supabase
        .from('rag_sources').select('id').eq('url', domain).maybeSingle();
    if (existing) return existing.id;

    const hostname = new URL(domain).hostname;
    const { data: inserted, error } = await supabase
        .from('rag_sources')
        .insert({ url: domain, title: hostname, source_type: 'html', category: 'subdomain' })
        .select('id').single();

    if (error) {
        console.error(`❌ RAG source eklenemedi (${domain}):`, error.message);
        return null;
    }
    return inserted.id;
}

// =====================================================
// DOKÜMAN + CHUNK KAYDI
// rag_documents: doc_id (text PK), title, url, category, source_type, content_hash
// rag_chunks: id (int8), doc_id (text FK), chunk_index, chunk_text, embedding, created_at
// =====================================================
async function saveDocumentAndChunks(sourceId, url, title, text, metadata = {}) {
    // doc_id olarak URL hash'i kullan
    const crypto = require('crypto');
    const docId = crypto.createHash('md5').update(url).digest('hex');
    const contentHash = crypto.createHash('md5').update(text).digest('hex');
    // DB check constraint sadece belirli source_type değerlerini kabul eder
    const rawType = metadata.type || 'html';
    const sourceType = ['html', 'pdf'].includes(rawType) ? rawType : 'html';
    const category = metadata.domain || 'cankaya.edu.tr';
    const department = metadata.department || null;

    // Chunk metadata objesi — AI filtreleme için kullanacak
    const chunkMeta = {};
    if (department) chunkMeta.department = department;
    // Fakülte bilgisi ekle
    const faculty = HOSTNAME_TO_FACULTY[metadata.domain] || null;
    if (faculty) chunkMeta.faculty = faculty;
    if (metadata.domain) chunkMeta.hostname = metadata.domain;
    if (sourceType) chunkMeta.source_type = sourceType;
    // Dil tespiti: en. prefix'i varsa İngilizce
    const language = metadata.language || ((metadata.domain || '').startsWith('en.') ? 'en' : 'tr');
    chunkMeta.language = language;
    // URL ve tarih
    chunkMeta.url = url;
    chunkMeta.crawl_date = new Date().toISOString().split('T')[0];
    // Hedef kitle tespiti
    const studentPrefixes = ['oim', 'oidb', 'registrar', 'kutuphane', 'sks', 'kariyer', 'pdrm', 'saglik', 'spor', 'yurt', 'odekan', 'erasmus', 'iro', 'mevlana', 'kariyermezun'];
    const adminPrefixes = ['kalite', 'kst', 'genelsekreterlik', 'rektorluk', 'bim', 'cc'];
    const domainPrefix = (metadata.domain || '').split('.')[0];
    if (studentPrefixes.includes(domainPrefix)) {
        chunkMeta.audience = 'ogrenci';
    } else if (adminPrefixes.includes(domainPrefix)) {
        chunkMeta.audience = 'idari';
    } else {
        chunkMeta.audience = 'genel';
    }

    // Mevcut doküman var mı?
    const { data: existing } = await supabase.from('rag_documents')
        .select('doc_id, content_hash').eq('doc_id', docId).maybeSingle();

    if (existing) {
        // İçerik değişmediyse VE chunk'lar varsa atla
        if (existing.content_hash === contentHash) {
            const { count } = await supabase.from('rag_chunks')
                .select('id', { count: 'exact', head: true }).eq('doc_id', docId);
            if (count && count > 0) return 0;
            console.log(`   🔄 Chunk'lar eksik, tekrar oluşturuluyor: ${(title || url).substring(0, 50)}`);
        }
        // Güncelle
        await supabase.from('rag_documents').update({
            title: title || url,
            content_hash: contentHash,
            source_type: sourceType,
            category: category,
            department: department,
            updated_from_source_at: new Date().toISOString()
        }).eq('doc_id', docId);
    } else {
        const { error: docErr } = await supabase.from('rag_documents').insert({
            doc_id: docId, url, title: title || url,
            source_type: sourceType, category: category,
            department: department,
            content_hash: contentHash
        });
        if (docErr) {
            console.error(`   ❌ Doküman eklenemedi: ${docErr.message}`);
            return 0;
        }
    }

    // Eski chunk'ları temizle
    await supabase.from('rag_chunks').delete().eq('doc_id', docId);

    // Chunk + embed
    const chunks = chunkText(text);
    let savedChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
        const embedding = await getEmbedding(chunks[i]);

        const chunkData = {
            doc_id: docId,
            chunk_index: i,
            chunk_text: chunks[i],
            metadata: chunkMeta
        };
        if (embedding) chunkData.embedding = embedding;

        const { error: chunkErr } = await supabase.from('rag_chunks').insert(chunkData);
        if (chunkErr) {
            // metadata kolonu henüz yoksa, onsuz dene
            delete chunkData.metadata;
            const { error: retryErr } = await supabase.from('rag_chunks').insert(chunkData);
            if (!retryErr) savedChunks++;
        } else {
            savedChunks++;
        }
        await delay(80);
    }

    return savedChunks;
}

// =====================================================
// HOSTNAME → BÖLÜM ADI EŞLEŞTİRMESİ (chunk'lara kontekst eklemek icin)
// =====================================================
const HOSTNAME_TO_DEPARTMENT = {
    // Mühendislik Fakültesi bölümleri
    'ceng.cankaya.edu.tr': 'Bilgisayar Mühendisliği', 'en.ceng.cankaya.edu.tr': 'Computer Engineering',
    'me.cankaya.edu.tr': 'Makine Mühendisliği', 'en.me.cankaya.edu.tr': 'Mechanical Engineering',
    'ce.cankaya.edu.tr': 'İnşaat Mühendisliği', 'en.ce.cankaya.edu.tr': 'Civil Engineering',
    'ee.cankaya.edu.tr': 'Elektrik-Elektronik Mühendisliği', 'en.ee.cankaya.edu.tr': 'Electrical-Electronics Engineering',
    'eee.cankaya.edu.tr': 'Elektrik-Elektronik Mühendisliği', // yeni kod
    'ie.cankaya.edu.tr': 'Endüstri Mühendisliği', 'en.ie.cankaya.edu.tr': 'Industrial Engineering',
    'ece.cankaya.edu.tr': 'Elektronik ve Haberleşme Mühendisliği', 'en.ece.cankaya.edu.tr': 'Electronics and Communication Engineering',
    'mece.cankaya.edu.tr': 'Mekatronik Mühendisliği', 'en.mece.cankaya.edu.tr': 'Mechatronics Engineering',
    'mse.cankaya.edu.tr': 'Malzeme Bilimi ve Mühendisliği',
    'malzeme.cankaya.edu.tr': 'Malzeme Bilimi ve Mühendisliği', // yeni kod
    'se.cankaya.edu.tr': 'Yazılım Mühendisliği',
    'yazilim.cankaya.edu.tr': 'Yazılım Mühendisliği', // yeni kod
    'muhf.cankaya.edu.tr': 'Mühendislik Fakültesi', // fakülte ana sayfa
    // Fen-Edebiyat Fakültesi bölümleri
    'math.cankaya.edu.tr': 'Matematik', 'en.math.cankaya.edu.tr': 'Mathematics',
    'ell.cankaya.edu.tr': 'İngiliz Dili ve Edebiyatı', 'en.ell.cankaya.edu.tr': 'English Language and Literature',
    'psy.cankaya.edu.tr': 'Psikoloji', 'en.psy.cankaya.edu.tr': 'Psychology',
    'mtb.cankaya.edu.tr': 'İngilizce Mütercim ve Tercümanlık', 'en.mtb.cankaya.edu.tr': 'Translation and Interpreting',
    'bb.cankaya.edu.tr': 'Bilgisayar Bilimleri', 'en.bb.cankaya.edu.tr': 'Computer Science', // DÜZELTİLDİ: Bankacılık değil
    'fef.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi', // fakülte ana sayfa
    // İktisadi ve İdari Bilimler Fakültesi bölümleri
    'econ.cankaya.edu.tr': 'İktisat', 'en.econ.cankaya.edu.tr': 'Economics',
    'iktisat.cankaya.edu.tr': 'İktisat', // yeni kod
    'economics.cankaya.edu.tr': 'İktisat',
    'ir.cankaya.edu.tr': 'Siyaset Bilimi ve Uluslararası İlişkiler',
    'sbu.cankaya.edu.tr': 'Siyaset Bilimi ve Uluslararası İlişkiler', // yeni kod
    'man.cankaya.edu.tr': 'İşletme', 'en.man.cankaya.edu.tr': 'Management',
    'bf.cankaya.edu.tr': 'Uluslararası Ticaret ve Finansman', 'en.bf.cankaya.edu.tr': 'International Trade and Finance',
    'intt.cankaya.edu.tr': 'Uluslararası Ticaret ve Finansman', // yeni kod
    'hir.cankaya.edu.tr': 'Halkla İlişkiler ve Reklamcılık', // yeni
    'mis.cankaya.edu.tr': 'Yönetim Bilişim Sistemleri', // yeni
    'ybs.cankaya.edu.tr': 'Yönetim Bilişim Sistemleri',
    'iibf.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi', // fakülte ana sayfa
    // Hukuk Fakültesi
    'law.cankaya.edu.tr': 'Hukuk Fakültesi', 'fld.cankaya.edu.tr': 'Hukuk Fakültesi',
    'hukuk.cankaya.edu.tr': 'Hukuk Fakültesi', // yeni kod
    // Mimarlık Fakültesi bölümleri
    'arch.cankaya.edu.tr': 'Mimarlık', 'architecture.cankaya.edu.tr': 'Mimarlık',
    'id.cankaya.edu.tr': 'İç Mimarlık', 'inar.cankaya.edu.tr': 'İç Mimarlık', 'en.inar.cankaya.edu.tr': 'Interior Architecture',
    'plan.cankaya.edu.tr': 'Şehir ve Bölge Planlama',
    'crp.cankaya.edu.tr': 'Şehir ve Bölge Planlama', // yeni kod
    'mimarlik.cankaya.edu.tr': 'Mimarlık Fakültesi', // fakülte ana sayfa
    // Enstitüler ve Yüksekokullar
    'fbe.cankaya.edu.tr': 'Fen Bilimleri Enstitüsü', 'en.fbe.cankaya.edu.tr': 'Graduate School of Natural and Applied Sciences',
    'sbe.cankaya.edu.tr': 'Sosyal Bilimler Enstitüsü', 'en.sbe.cankaya.edu.tr': 'Graduate School of Social Sciences',
    'gs.cankaya.edu.tr': 'Lisansüstü Eğitim',
    'lee.cankaya.edu.tr': 'Lisansüstü Eğitim Enstitüsü', // yeni
    'adalet.cankaya.edu.tr': 'Adalet Meslek Yüksekokulu', // yeni
    'myo.cankaya.edu.tr': 'Meslek Yüksekokulu', // yeni
    // İdari birimler
    'oim.cankaya.edu.tr': 'Uluslararası İlişkiler Ofisi',
    'oidb.cankaya.edu.tr': 'Öğrenci İşleri Daire Başkanlığı',
    'registrar.cankaya.edu.tr': 'Öğrenci İşleri',
    'kutuphane.cankaya.edu.tr': 'Kütüphane',
    'spor.cankaya.edu.tr': 'Spor Birimi',
    'saglik.cankaya.edu.tr': 'Sağlık Birimi',
    'kariyer.cankaya.edu.tr': 'Kariyer Merkezi',
    'kalite.cankaya.edu.tr': 'Kalite Güvence Birimi',
    'iro.cankaya.edu.tr': 'Uluslararası İlişkiler Ofisi',
    'erasmus.cankaya.edu.tr': 'Erasmus Ofisi',
    'mevlana.cankaya.edu.tr': 'Mevlana Ofisi', // yeni
    'sks.cankaya.edu.tr': 'Sağlık Kültür ve Spor',
    'pdrm.cankaya.edu.tr': 'Psikolojik Danışmanlık',
    'cc.cankaya.edu.tr': 'Bilgi İşlem',
    'bim.cankaya.edu.tr': 'Bilgi İşlem', // yeni
    'odekan.cankaya.edu.tr': 'Öğrenci Dekanlığı', // yeni
    'rektorluk.cankaya.edu.tr': 'Rektörlük', // yeni
    'genelsekreterlik.cankaya.edu.tr': 'Genel Sekreterlik', // yeni
    'kariyermezun.cankaya.edu.tr': 'Kariyer-Mezun İlişkileri', // yeni
    'kst.cankaya.edu.tr': 'Kalite, Strateji ve Teknoloji Geliştirme', // yeni
    'kultur.cankaya.edu.tr': 'Kültür Birimi', // yeni
    'yurt.cankaya.edu.tr': 'Öğrenci Yurdu', // yeni
    // Ana site
    'cankaya.edu.tr': 'Çankaya Üniversitesi',
    'www.cankaya.edu.tr': 'Çankaya Üniversitesi',
};

// =====================================================
// HOSTNAME → FAKÜLTE EŞLEŞTİRMESİ (chunk metadata için)
// =====================================================
const HOSTNAME_TO_FACULTY = {
    // Mühendislik Fakültesi
    'ceng.cankaya.edu.tr': 'Mühendislik Fakültesi', 'en.ceng.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'me.cankaya.edu.tr': 'Mühendislik Fakültesi', 'en.me.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'ce.cankaya.edu.tr': 'Mühendislik Fakültesi', 'en.ce.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'ee.cankaya.edu.tr': 'Mühendislik Fakültesi', 'en.ee.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'eee.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'ie.cankaya.edu.tr': 'Mühendislik Fakültesi', 'en.ie.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'ece.cankaya.edu.tr': 'Mühendislik Fakültesi', 'en.ece.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'mece.cankaya.edu.tr': 'Mühendislik Fakültesi', 'en.mece.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'mse.cankaya.edu.tr': 'Mühendislik Fakültesi', 'malzeme.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'se.cankaya.edu.tr': 'Mühendislik Fakültesi', 'yazilim.cankaya.edu.tr': 'Mühendislik Fakültesi',
    'muhf.cankaya.edu.tr': 'Mühendislik Fakültesi',
    // Fen-Edebiyat Fakültesi
    'math.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi', 'en.math.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi',
    'ell.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi', 'en.ell.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi',
    'psy.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi', 'en.psy.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi',
    'mtb.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi', 'en.mtb.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi',
    'bb.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi', 'en.bb.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi',
    'fef.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi',
    // İktisadi ve İdari Bilimler Fakültesi
    'econ.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi', 'en.econ.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'iktisat.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'economics.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'ir.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'sbu.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'man.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi', 'en.man.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'bf.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi', 'en.bf.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'intt.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'hir.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'mis.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'ybs.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    'iibf.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',
    // Hukuk Fakültesi
    'law.cankaya.edu.tr': 'Hukuk Fakültesi', 'fld.cankaya.edu.tr': 'Hukuk Fakültesi',
    'hukuk.cankaya.edu.tr': 'Hukuk Fakültesi',
    // Mimarlık Fakültesi
    'arch.cankaya.edu.tr': 'Mimarlık Fakültesi', 'architecture.cankaya.edu.tr': 'Mimarlık Fakültesi',
    'id.cankaya.edu.tr': 'Mimarlık Fakültesi', 'inar.cankaya.edu.tr': 'Mimarlık Fakültesi', 'en.inar.cankaya.edu.tr': 'Mimarlık Fakültesi',
    'plan.cankaya.edu.tr': 'Mimarlık Fakültesi', 'crp.cankaya.edu.tr': 'Mimarlık Fakültesi',
    'mimarlik.cankaya.edu.tr': 'Mimarlık Fakültesi',
};

function getDepartmentLabel(hostname) {
    if (HOSTNAME_TO_DEPARTMENT[hostname]) return HOSTNAME_TO_DEPARTMENT[hostname];
    // en. prefix'ini kaldir ve tekrar dene
    if (hostname.startsWith('en.')) {
        const trHost = hostname.replace('en.', '');
        if (HOSTNAME_TO_DEPARTMENT[trHost]) return HOSTNAME_TO_DEPARTMENT[trHost] + ' (EN)';
    }
    // Ders sitelerini yakala (ör: ce102.cankaya.edu.tr -> İnşaat Mühendisliği Dersi)
    const dersMatch = hostname.match(/^([a-z]+)\d+\.cankaya\.edu\.tr$/);
    if (dersMatch) {
        const prefix = dersMatch[1];
        const deptMap = { ce: 'İnşaat Müh.', me: 'Makine Müh.', ee: 'Elektrik-Elektronik Müh.', ece: 'Elektronik ve Haberleşme Müh.',
            mse: 'Malzeme Bilimi', math: 'Matematik', psi: 'Psikoloji', ell: 'İngiliz Dili', inar: 'İç Mimarlık',
            ceng: 'Bilgisayar Müh.', mece: 'Mekatronik Müh.' };
        if (deptMap[prefix]) return `${deptMap[prefix]} Ders Sayfası`;
    }
    return hostname; // fallback: hostname'i döndür
}

// =====================================================
// SUBDOMAIN ERIŞILEBILIRLIK KONTROLÜ
// =====================================================
async function isSubdomainReachable(hostname) {
    try {
        const res = await axios.get(`https://${hostname}`, {
            timeout: 8000,
            maxRedirects: 3,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            validateStatus: (status) => status < 500
        });
        return res.status < 400;
    } catch {
        // HTTPS başarısızsa HTTP dene
        try {
            const res = await axios.get(`http://${hostname}`, {
                timeout: 8000,
                maxRedirects: 3,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                validateStatus: (status) => status < 500
            });
            return res.status < 400;
        } catch {
            return false;
        }
    }
}

// =====================================================
// BİR SUBDOMAİN'İ TARA (HTML + PDF)
// =====================================================
async function crawlSubdomain(baseUrl) {
    const hostname = new URL(baseUrl).hostname;
    const deptLabel = getDepartmentLabel(hostname);

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🌐 Taranıyor: ${baseUrl} [${deptLabel}]`);
    console.log('─'.repeat(50));

    const sourceId = await ensureRagSource(baseUrl);
    if (!sourceId) return { pages: 0, chunks: 0 };

    const visited = new Set();
    const pdfQueue = new Set();
    const officeQueue = new Set();
    const queue = [{ url: baseUrl, depth: 0 }];
    let totalPages = 0;
    let totalPdfs = 0;
    let totalOffice = 0;
    let totalChunks = 0;

    // --- HTML SAYFALARINI TARA ---
    while (queue.length > 0 && totalPages < MAX_PAGES_PER_DOMAIN) {
        const { url, depth } = queue.shift();

        const normalizedUrl = url.replace(/\/$/, '');
        if (visited.has(normalizedUrl)) continue;
        visited.add(normalizedUrl);

        const html = await fetchPage(url);
        if (!html) continue;

        const $ = cheerio.load(html);
        const title = $('title').text().trim() || url;
        const rawText = htmlToText(html);

        if (rawText.length < 100) continue;

        // Chunk'a bölüm konteksti ekle (RAG aramasinda dogru bolumun donmesini saglar)
        const text = `[${deptLabel}] ${title}\n${rawText}`;

        const chunkCount = await saveDocumentAndChunks(sourceId, url, title, text, {
            source: 'subdomain_crawl', type: 'html',
            domain: hostname,
            department: deptLabel !== hostname ? deptLabel : null
        });

        totalPages++;
        totalChunks += chunkCount;
        console.log(`   📄 [${totalPages}] ${title.substring(0, 60)}... (${chunkCount} chunk)`);

        if (depth < MAX_DEPTH) {
            const { htmlLinks, pdfLinks, officeLinks } = extractLinks(html, url);
            for (const link of htmlLinks) {
                const normLink = link.replace(/\/$/, '');
                if (!visited.has(normLink)) queue.push({ url: link, depth: depth + 1 });
            }
            for (const pdfUrl of pdfLinks) pdfQueue.add(pdfUrl);
            for (const officeUrl of officeLinks) officeQueue.add(officeUrl);
        }

        // Chunk oluşturulmadıysa (zaten DB'de var) kısa bekle, yeni chunk varsa normal bekle
        await smartDelay(chunkCount === 0 ? 200 : 500);
    }

    // --- PDF'LERİ İŞLE ---
    if (pdfQueue.size > 0) {
        console.log(`   📎 ${pdfQueue.size} PDF bulundu, işleniyor...`);

        for (const pdfUrl of pdfQueue) {
            if (visited.has(pdfUrl)) continue;
            visited.add(pdfUrl);

            const pdfResult = await fetchAndParsePdf(pdfUrl);
            if (!pdfResult || pdfResult.text.length < 100) continue;

            const pdfName = decodeURIComponent(pdfUrl.split('/').pop() || 'document.pdf');
            // PDF'e de bölüm konteksti ekle
            const pdfTextWithContext = `[${deptLabel}] ${pdfResult.title || pdfName}\n${pdfResult.text}`;
            const chunkCount = await saveDocumentAndChunks(sourceId, pdfUrl, pdfResult.title || pdfName, pdfTextWithContext, {
                source: 'subdomain_crawl', type: 'pdf',
                domain: hostname,
                department: deptLabel !== hostname ? deptLabel : null,
                filename: pdfName, pdf_pages: pdfResult.pages
            });

            totalPdfs++;
            totalChunks += chunkCount;
            console.log(`   📎 [PDF ${totalPdfs}] ${pdfName.substring(0, 50)} (${pdfResult.pages}p, ${chunkCount} chunk)`);
            await smartDelay(chunkCount === 0 ? 200 : 600);
        }
    }

    // --- OFFICE DOSYALARINI İŞLE ---
    if (officeQueue.size > 0) {
        console.log(`   📋 ${officeQueue.size} Office dosyası bulundu, işleniyor...`);

        for (const officeUrl of officeQueue) {
            if (visited.has(officeUrl)) continue;
            visited.add(officeUrl);

            const officeResult = await fetchAndParseOffice(officeUrl);
            if (!officeResult) continue;

            const fileName = decodeURIComponent(officeUrl.split('/').pop() || 'document');
            const officeTextWithContext = `[${deptLabel}] ${officeResult.title || fileName}\n${officeResult.text}`;
            const chunkCount = await saveDocumentAndChunks(sourceId, officeUrl, officeResult.title || fileName, officeTextWithContext, {
                source: 'subdomain_crawl', type: officeResult.type,
                domain: hostname,
                department: deptLabel !== hostname ? deptLabel : null,
                filename: fileName
            });

            totalOffice++;
            totalChunks += chunkCount;
            console.log(`   📋 [${officeResult.type.toUpperCase()} ${totalOffice}] ${fileName.substring(0, 50)} (${chunkCount} chunk)`);
            await smartDelay(chunkCount === 0 ? 200 : 500);
        }
    }

    console.log(`   ✅ ${new URL(baseUrl).hostname}: ${totalPages} HTML + ${totalPdfs} PDF + ${totalOffice} Office = ${totalChunks} chunk`);
    return { pages: totalPages + totalPdfs + totalOffice, chunks: totalChunks };
}

// =====================================================
// ANA FONKSİYON
// =====================================================
(async () => {
    console.log('🔄 Çankaya Üniversitesi Tüm Subdomain Crawler Başlatılıyor...\n');

    // 1. Subdomain keşfi: crt.sh + fallback listesini BİRLEŞTİR
    const crtResults = await discoverSubdomains();
    const mergedSet = new Set(FALLBACK_SUBDOMAINS); // Önce sabit listeyi ekle
    if (crtResults && crtResults.length > 0) {
        for (const h of crtResults) mergedSet.add(h); // crt.sh sonuçlarını da ekle
        console.log(`   🔗 Birleştirildi: ${FALLBACK_SUBDOMAINS.length} sabit + ${crtResults.length} crt.sh = ${mergedSet.size} benzersiz`);
    } else {
        console.log('⚠️ crt.sh başarısız, sadece sabit liste kullanılıyor...');
    }
    let allHostnames = [...mergedSet];

    // 2. Atlanacak subdomain'leri filtrele
    const filtered = allHostnames.filter(h => {
        const clean = h.replace(/^www\./, '');
        if (SKIP_SUBDOMAINS.has(clean)) return false;
        if (SKIP_SUBDOMAINS.has(h)) return false;
        return true;
    });

    // Benzersiz yap
    const unique = [...new Set(filtered)];
    console.log(`\n📋 ${unique.length} subdomain işlenecek (${allHostnames.length} bulundu, ${allHostnames.length - unique.length} filtrelendi)\n`);

    // 3. Erişilebilirlik kontrolü + crawl
    let grandTotalPages = 0;
    let grandTotalChunks = 0;
    let reachableCount = 0;
    let unreachableCount = 0;
    const crawlLog = []; // Her subdomain'in durumunu logla

    // Öncelikli subdomain'leri listenin başına al
    const priorityHostnames = [...new Set(PRIORITY_URLS.map(u => new URL(u).hostname))];
    const nonPriority = unique.filter(h => !priorityHostnames.includes(h));
    const orderedList = [...priorityHostnames, ...nonPriority];
    console.log(`⭐ ${priorityHostnames.length} öncelikli subdomain ilk sırada taranacak\n`);

    for (let i = 0; i < orderedList.length; i++) {
        const hostname = orderedList[i];
        console.log(`\n[${i + 1}/${orderedList.length}] ${hostname} kontrol ediliyor...`);

        const reachable = await isSubdomainReachable(hostname);
        if (!reachable) {
            console.log(`   ⏭️ Erişilemiyor, atlanıyor`);
            unreachableCount++;
            crawlLog.push({ hostname, status: 'unreachable', pages: 0, chunks: 0, error: null, timestamp: new Date().toISOString() });
            continue;
        }

        reachableCount++;
        const baseUrl = `https://${hostname}`;

        try {
            const result = await crawlSubdomain(baseUrl);
            if (result) {
                grandTotalPages += result.pages;
                grandTotalChunks += result.chunks;
                crawlLog.push({ hostname, status: 'crawled', pages: result.pages, chunks: result.chunks, error: null, timestamp: new Date().toISOString() });
            }
        } catch (err) {
            console.error(`❌ ${hostname} taranırken hata:`, err.message);
            crawlLog.push({ hostname, status: 'error', pages: 0, chunks: 0, error: err.message, timestamp: new Date().toISOString() });
        }

        // Subdomain'ler arasi mola
        await smartDelay(1500);
    }

    // Crawl log özeti
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Subdomain Crawl Tamamlandı!`);
    console.log(`   Erişilen: ${reachableCount} | Erişilemeyen: ${unreachableCount}`);
    console.log(`   Toplam: ${grandTotalPages} sayfa/PDF, ${grandTotalChunks} chunk`);
    console.log(`   📊 Embedding: ${successfulEmbeddings} başarılı, ${skippedEmbeddings} atlandı${embeddingDisabled ? ' (kota doldu — tekrar çalıştır)' : ''}`);
    console.log('='.repeat(60));

    // Detaylı crawl log çıktısı
    console.log('\n📋 CRAWL LOG:');
    console.log(JSON.stringify(crawlLog, null, 2));

    // Hata alan subdomain'leri ayrıca listele
    const failed = crawlLog.filter(l => l.status === 'error' || l.status === 'unreachable');
    if (failed.length > 0) {
        console.log(`\n⚠️ ${failed.length} subdomain taranaMADI:`);
        for (const f of failed) {
            console.log(`   - ${f.hostname}: ${f.status}${f.error ? ' (' + f.error + ')' : ''}`);
        }
    }
})();
