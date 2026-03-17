require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');

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
const MAX_DEPTH = 3;              // Link takip derinliği
const MAX_PAGES_PER_DOMAIN = 150; // Her subdomain için max sayfa (sunucu yukunu azalt)
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

// Yedek sabit liste (crt.sh çalışmazsa)
const FALLBACK_SUBDOMAINS = [
    // Ana site
    'cankaya.edu.tr', 'www.cankaya.edu.tr',
    // Öğrenci hizmetleri
    'oim.cankaya.edu.tr', 'oidb.cankaya.edu.tr', 'registrar.cankaya.edu.tr',
    'kutuphane.cankaya.edu.tr', 'spor.cankaya.edu.tr', 'saglik.cankaya.edu.tr',
    'pdrm.cankaya.edu.tr', 'sks.cankaya.edu.tr', 'kariyer.cankaya.edu.tr',
    // Uluslararası
    'iro.cankaya.edu.tr', 'erasmus.cankaya.edu.tr',
    // İdari
    'kalite.cankaya.edu.tr', 'cc.cankaya.edu.tr',
    // Mühendislik Fakültesi
    'fbe.cankaya.edu.tr', 'en.fbe.cankaya.edu.tr',
    'ceng.cankaya.edu.tr', 'me.cankaya.edu.tr', 'ce.cankaya.edu.tr',
    'ee.cankaya.edu.tr', 'ie.cankaya.edu.tr', 'ece.cankaya.edu.tr',
    'mece.cankaya.edu.tr', 'mse.cankaya.edu.tr',
    'en.ceng.cankaya.edu.tr', 'en.me.cankaya.edu.tr', 'en.ce.cankaya.edu.tr',
    'en.ee.cankaya.edu.tr', 'en.ie.cankaya.edu.tr', 'en.ece.cankaya.edu.tr',
    'en.mece.cankaya.edu.tr',
    // Fen-Edebiyat Fakültesi
    'math.cankaya.edu.tr', 'ell.cankaya.edu.tr', 'psy.cankaya.edu.tr',
    'mtb.cankaya.edu.tr',
    'en.math.cankaya.edu.tr', 'en.ell.cankaya.edu.tr', 'en.psy.cankaya.edu.tr',
    'en.mtb.cankaya.edu.tr',
    // İktisadi ve İdari Bilimler
    'bb.cankaya.edu.tr', 'econ.cankaya.edu.tr', 'ir.cankaya.edu.tr',
    'man.cankaya.edu.tr', 'bf.cankaya.edu.tr', 'psi.cankaya.edu.tr',
    'economics.cankaya.edu.tr',
    'en.bb.cankaya.edu.tr', 'en.econ.cankaya.edu.tr', 'en.man.cankaya.edu.tr',
    'en.bf.cankaya.edu.tr',
    // Hukuk
    'law.cankaya.edu.tr', 'fld.cankaya.edu.tr',
    // Mimarlık
    'arch.cankaya.edu.tr', 'architecture.cankaya.edu.tr',
    'id.cankaya.edu.tr', 'inar.cankaya.edu.tr',
    'en.inar.cankaya.edu.tr',
    // Enstitüler
    'gs.cankaya.edu.tr', 'sbe.cankaya.edu.tr',
    'en.sbe.cankaya.edu.tr', 'en.gs.cankaya.edu.tr',
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

// Dosya uzantıları
const SKIP_EXTENSIONS = /\.(jpg|jpeg|png|gif|svg|webp|ico|bmp|tiff|mp4|mp3|wav|avi|mov|zip|rar|7z|tar|gz|exe|dmg|msi|css|js|woff|woff2|ttf|eot)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const OFFICE_EXTENSIONS = /\.(doc|docx|xls|xlsx|ppt|pptx)$/i;

// =====================================================
// EMBEDDING FONKSİYONU (Google Gemini - Ucretsiz, 768 boyut)
// =====================================================
async function getEmbedding(text) {
    if (!GEMINI_API_KEY) return null;
    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
            {
                content: { parts: [{ text: text.substring(0, 8000) }] }
            },
            { headers: { 'Content-Type': 'application/json' } }
        );
        return res.data.embedding.values;
    } catch (err) {
        console.error('❌ Embedding hatası:', err.response?.data?.error?.message || err.message);
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
// LINK ÇIKARMA (HTML + PDF ayrı)
// =====================================================
function extractLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const htmlLinks = new Set();
    const pdfLinks = new Set();
    const baseHost = new URL(baseUrl).hostname;

    $('a[href]').each((_, el) => {
        let href = $(el).attr('href');
        if (!href) return;
        if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        if (SKIP_EXTENSIONS.test(href)) return;
        if (OFFICE_EXTENSIONS.test(href)) return;

        try {
            const fullUrl = new URL(href, baseUrl);
            const isSameDomain = fullUrl.hostname === baseHost;
            const isCankayaDomain = fullUrl.hostname.endsWith('cankaya.edu.tr');

            if ((isSameDomain || isCankayaDomain) && fullUrl.protocol.startsWith('http')) {
                fullUrl.hash = '';
                if (PDF_EXTENSION.test(fullUrl.pathname)) {
                    pdfLinks.add(fullUrl.href);
                } else if (isSameDomain) {
                    htmlLinks.add(fullUrl.href);
                }
            }
        } catch { /* geçersiz URL */ }
    });

    return { htmlLinks, pdfLinks };
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
    const sourceType = metadata.type || 'html';
    const category = metadata.domain || 'cankaya.edu.tr';

    // Mevcut doküman var mı?
    const { data: existing } = await supabase.from('rag_documents')
        .select('doc_id, content_hash').eq('doc_id', docId).maybeSingle();

    if (existing) {
        // İçerik değişmediyse atla
        if (existing.content_hash === contentHash) return 0;
        // Güncelle
        await supabase.from('rag_documents').update({
            title: title || url,
            content_hash: contentHash,
            source_type: sourceType,
            category: category,
            updated_from_source_at: new Date().toISOString()
        }).eq('doc_id', docId);
    } else {
        const { error: docErr } = await supabase.from('rag_documents').insert({
            doc_id: docId, url, title: title || url,
            source_type: sourceType, category: category,
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

        // Embedding olsa da olmasa da chunk'i kaydet (embedding sonra eklenebilir)
        const chunkData = { doc_id: docId, chunk_index: i, chunk_text: chunks[i] };
        if (embedding) chunkData.embedding = embedding;

        const { error: chunkErr } = await supabase.from('rag_chunks').insert(chunkData);
        if (chunkErr) {
            // Embedding zorunlu olabilir, embedding'siz deneyelim
            if (embedding) {
                const { error: retryErr } = await supabase.from('rag_chunks').insert({
                    doc_id: docId, chunk_index: i, chunk_text: chunks[i]
                });
                if (!retryErr) savedChunks++;
            }
        } else {
            savedChunks++;
        }
        await delay(150);
    }

    return savedChunks;
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
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🌐 Taranıyor: ${baseUrl}`);
    console.log('─'.repeat(50));

    const sourceId = await ensureRagSource(baseUrl);
    if (!sourceId) return { pages: 0, chunks: 0 };

    const visited = new Set();
    const pdfQueue = new Set();
    const queue = [{ url: baseUrl, depth: 0 }];
    let totalPages = 0;
    let totalPdfs = 0;
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
        const text = htmlToText(html);

        if (text.length < 100) continue;

        const chunkCount = await saveDocumentAndChunks(sourceId, url, title, text, {
            source: 'subdomain_crawl', type: 'html',
            domain: new URL(baseUrl).hostname
        });

        totalPages++;
        totalChunks += chunkCount;
        console.log(`   📄 [${totalPages}] ${title.substring(0, 60)}... (${chunkCount} chunk)`);

        if (depth < MAX_DEPTH) {
            const { htmlLinks, pdfLinks } = extractLinks(html, url);
            for (const link of htmlLinks) {
                const normLink = link.replace(/\/$/, '');
                if (!visited.has(normLink)) queue.push({ url: link, depth: depth + 1 });
            }
            for (const pdfUrl of pdfLinks) pdfQueue.add(pdfUrl);
        }

        await smartDelay(600);
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
            const chunkCount = await saveDocumentAndChunks(sourceId, pdfUrl, pdfResult.title || pdfName, pdfResult.text, {
                source: 'subdomain_crawl', type: 'pdf',
                domain: new URL(baseUrl).hostname,
                filename: pdfName, pdf_pages: pdfResult.pages
            });

            totalPdfs++;
            totalChunks += chunkCount;
            console.log(`   📎 [PDF ${totalPdfs}] ${pdfName.substring(0, 50)} (${pdfResult.pages}p, ${chunkCount} chunk)`);
            await smartDelay(800);
        }
    }

    // Subdomain'ler arasi uzun mola (farkli IP'ye gecis gibi gorunsun)
    console.log(`   ✅ ${new URL(baseUrl).hostname}: ${totalPages} HTML + ${totalPdfs} PDF = ${totalChunks} chunk`);
    return { pages: totalPages + totalPdfs, chunks: totalChunks };
}

// =====================================================
// ANA FONKSİYON
// =====================================================
(async () => {
    console.log('🔄 Çankaya Üniversitesi Tüm Subdomain Crawler Başlatılıyor...\n');

    // 1. Subdomain keşfi
    let allHostnames = await discoverSubdomains();
    if (!allHostnames || allHostnames.length === 0) {
        console.log('⚠️ Otomatik keşif başarısız, yedek liste kullanılıyor...');
        allHostnames = FALLBACK_SUBDOMAINS;
    }

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

    for (let i = 0; i < unique.length; i++) {
        const hostname = unique[i];
        console.log(`\n[${i + 1}/${unique.length}] ${hostname} kontrol ediliyor...`);

        const reachable = await isSubdomainReachable(hostname);
        if (!reachable) {
            console.log(`   ⏭️ Erişilemiyor, atlanıyor`);
            unreachableCount++;
            continue;
        }

        reachableCount++;
        const baseUrl = `https://${hostname}`;

        try {
            const result = await crawlSubdomain(baseUrl);
            if (result) {
                grandTotalPages += result.pages;
                grandTotalChunks += result.chunks;
            }
        } catch (err) {
            console.error(`❌ ${hostname} taranırken hata:`, err.message);
        }

        // Subdomain'ler arasi 2-4sn mola (farkli kullanici oturumu simulasyonu)
        await smartDelay(3000);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Subdomain Crawl Tamamlandı!`);
    console.log(`   Erişilen: ${reachableCount} | Erişilemeyen: ${unreachableCount}`);
    console.log(`   Toplam: ${grandTotalPages} sayfa/PDF, ${grandTotalChunks} chunk`);
    console.log('='.repeat(60));
})();
