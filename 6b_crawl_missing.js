/**
 * @deprecated Bu script artık kullanılmıyor.
 * Tüm subdomain'ler 6_crawl_subdomains.js'e taşındı (Mart 2026).
 * Bu dosya referans amaçlı saklanmaktadır.
 *
 * Eski açıklama:
 * 6b_crawl_missing.js — Sadece RAG'da eksik olan subdomain'leri tarardı.
 */
console.log('⚠️ Bu script artık kullanılmıyor. Tüm subdomain\'ler 6_crawl_subdomains.js\'e taşındı.');
console.log('   Lütfen 6_crawl_subdomains.js\'i çalıştırın.');
process.exit(0);

/* --- ESKİ KOD (referans için) --- */

// Orijinal script'teki tüm modülleri yükle
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey) throw new Error("❌ Supabase URL veya Key eksik!");

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));
function smartDelay(baseMs = 500) {
    const jitter = baseMs * 0.4 * (Math.random() * 2 - 1);
    return delay(Math.max(200, Math.round(baseMs + jitter)));
}

// --- DOĞRU SUBDOMAIN LİSTESİ (Mart 2026 güncel) ---
const MISSING_SUBDOMAINS = [
    // === FAKÜLTELER (ÖNCELİKLİ) ===
    'fef.cankaya.edu.tr',           // Fen-Edebiyat Fakültesi
    'iibf.cankaya.edu.tr',          // İktisadi ve İdari Bilimler Fakültesi
    'muhf.cankaya.edu.tr',          // Mühendislik Fakültesi
    'mimarlik.cankaya.edu.tr',      // Mimarlık Fakültesi
    'hukuk.cankaya.edu.tr',         // Hukuk Fakültesi

    // === BÖLÜMLER — DOĞRU KODLAR (ÖNCELİKLİ) ===
    'eee.cankaya.edu.tr',           // Elektrik-Elektronik Mühendisliği (eski: ee)
    'yazilim.cankaya.edu.tr',       // Yazılım Mühendisliği (eski: se)
    'malzeme.cankaya.edu.tr',       // Malzeme Bilimi ve Mühendisliği (eski: mse)
    'iktisat.cankaya.edu.tr',       // İktisat (eski: econ)
    'sbu.cankaya.edu.tr',           // Siyaset Bilimi ve Uluslararası İlişkiler (eski: ir/psi)
    'intt.cankaya.edu.tr',          // Uluslararası Ticaret ve Finansman
    'hir.cankaya.edu.tr',           // Halkla İlişkiler ve Reklamcılık
    'mis.cankaya.edu.tr',           // Yönetim Bilişim Sistemleri
    'crp.cankaya.edu.tr',           // Şehir ve Bölge Planlama
    'bb.cankaya.edu.tr',            // Bilgisayar Bilimleri (NOT Bankacılık!)
    'bf.cankaya.edu.tr',            // Bankacılık ve Finans
    'psy.cankaya.edu.tr',           // Psikoloji
    'mtb.cankaya.edu.tr',           // İngilizce Mütercim ve Tercümanlık
    'man.cankaya.edu.tr',           // İşletme
    'arch.cankaya.edu.tr',          // Mimarlık
    'inar.cankaya.edu.tr',          // İç Mimarlık
    'mece.cankaya.edu.tr',          // Mekatronik Mühendisliği
    'ie.cankaya.edu.tr',            // Endüstri Mühendisliği

    // === ENSTİTÜ / YÜKSEKOKUL ===
    'lee.cankaya.edu.tr',           // Lisansüstü Eğitim Enstitüsü (eski: fbe/sbe/gs)
    'adalet.cankaya.edu.tr',        // Adalet Meslek Yüksekokulu
    'myo.cankaya.edu.tr',           // Çankaya Meslek Yüksekokulu

    // === İDARİ BİRİMLER (ÖĞRENCİ İÇİN ÖNEMLİ) ===
    'odekan.cankaya.edu.tr',        // Öğrenci Dekanlığı
    'rektorluk.cankaya.edu.tr',     // Rektörlük
    'genelsekreterlik.cankaya.edu.tr', // Genel Sekreterlik
    'bim.cankaya.edu.tr',           // Bilgi İşlem
    'kariyermezun.cankaya.edu.tr',  // Kariyer-Mezun İlişkileri
    'kst.cankaya.edu.tr',           // Kalite, Strateji ve Teknoloji Geliştirme
    'kultur.cankaya.edu.tr',        // Kültür (engelli öğrenci birimi dahil)
    'yurt.cankaya.edu.tr',          // Öğrenci Yurdu
    'mevlana.cankaya.edu.tr',      // Mevlana Ofisi

    // === ESKİ KODLAR (FALLBACK — erişilebilirse dene) ===
    'gs.cankaya.edu.tr',
    'sbe.cankaya.edu.tr',
    'fbe.cankaya.edu.tr',
];

// --- AYARLAR ---
const MAX_DEPTH = 3;
const MAX_PAGES_PER_DOMAIN = 150;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

// KVKK filtreleri
const PHONE_REGEX = /(\+?90[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|0\d{3}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const TC_REGEX = /\b[1-9]\d{10}\b/g;

function sanitizePersonalData(text) {
    return text.replace(PHONE_REGEX, '[TELEFON]').replace(EMAIL_REGEX, '[E-POSTA]').replace(TC_REGEX, '[TC-NO]');
}

// Dosya uzantıları
const SKIP_EXTENSIONS = /\.(jpg|jpeg|png|gif|svg|webp|ico|bmp|tiff|mp4|mp3|wav|avi|mov|zip|rar|7z|tar|gz|exe|dmg|msi|css|js|woff|woff2|ttf|eot)$/i;
const PDF_EXTENSION = /\.pdf$/i;

// Embedding
let embedRequestCount = 0;
let embedMinuteStart = Date.now();
const MAX_EMBEDS_PER_MINUTE = 900;
let consecutiveEmbedFailures = 0;
let embeddingDisabled = false;
let successfulEmbeddings = 0;
let skippedEmbeddings = 0;

async function getEmbedding(text, retryCount = 0) {
    if (!GEMINI_API_KEY) return null;
    if (embeddingDisabled) { skippedEmbeddings++; return null; }

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
            { content: { parts: [{ text: text.substring(0, 8000) }] }, outputDimensionality: 768 },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        consecutiveEmbedFailures = 0;
        successfulEmbeddings++;
        return res.data.embedding.values;
    } catch (err) {
        const status = err.response?.status;
        if (status === 429 || status === 503) {
            consecutiveEmbedFailures++;
            if (consecutiveEmbedFailures >= 3) {
                console.warn('   ⚠️ Embedding kota doldu — embedding kapatıldı, chunk\'lar embedding\'siz kaydedilecek');
                embeddingDisabled = true;
                skippedEmbeddings++;
                return null;
            }
            if (retryCount < 2) {
                await delay(5000 * (retryCount + 1));
                return getEmbedding(text, retryCount + 1);
            }
        }
        skippedEmbeddings++;
        return null;
    }
}

// HTML → temiz metin
function htmlToText(html) {
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, iframe, noscript, .breadcrumb, .menu, .sidebar, .cookie-notice').remove();
    let text = $('body').text() || $.text();
    text = text.replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    text = sanitizePersonalData(text);
    return text;
}

// Chunk
function chunkText(text) {
    const words = text.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        const chunk = words.slice(i, i + CHUNK_SIZE).join(' ');
        if (chunk.length > 50) chunks.push(chunk);
    }
    return chunks;
}

// Sayfa fetch
async function fetchPage(url) {
    try {
        const res = await axios.get(url, {
            timeout: 15000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            responseType: 'text',
            validateStatus: (s) => s < 400
        });
        return res.data;
    } catch { return null; }
}

// PDF fetch + parse
async function fetchAndParsePdf(url) {
    try {
        const res = await axios.get(url, {
            timeout: 30000, responseType: 'arraybuffer',
            maxContentLength: MAX_PDF_SIZE,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const result = await pdfParse(Buffer.from(res.data));
        const text = sanitizePersonalData(result.text || '');
        return { text, title: result.info?.Title || null, pages: result.numpages || 0 };
    } catch { return null; }
}

// Link çıkarma
function extractLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const base = new URL(baseUrl);
    const htmlLinks = [];
    const pdfLinks = [];

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
        try {
            const resolved = new URL(href, baseUrl);
            if (resolved.hostname !== base.hostname) return;
            const clean = resolved.href.split('#')[0];
            if (SKIP_EXTENSIONS.test(clean)) return;
            if (PDF_EXTENSION.test(clean)) { pdfLinks.push(clean); return; }
            htmlLinks.push(clean);
        } catch {}
    });

    return { htmlLinks, pdfLinks };
}

// Hostname → bölüm
const HOSTNAME_TO_DEPARTMENT = {
    // Mühendislik Fakültesi
    'ceng.cankaya.edu.tr': 'Bilgisayar Mühendisliği',
    'me.cankaya.edu.tr': 'Makine Mühendisliği',
    'ce.cankaya.edu.tr': 'İnşaat Mühendisliği',
    'eee.cankaya.edu.tr': 'Elektrik-Elektronik Mühendisliği',
    'ee.cankaya.edu.tr': 'Elektrik-Elektronik Mühendisliği',   // eski kod
    'ie.cankaya.edu.tr': 'Endüstri Mühendisliği',
    'ece.cankaya.edu.tr': 'Elektronik ve Haberleşme Mühendisliği',
    'mece.cankaya.edu.tr': 'Mekatronik Mühendisliği',
    'malzeme.cankaya.edu.tr': 'Malzeme Bilimi ve Mühendisliği',
    'mse.cankaya.edu.tr': 'Malzeme Bilimi ve Mühendisliği',    // eski kod
    'yazilim.cankaya.edu.tr': 'Yazılım Mühendisliği',
    'muhf.cankaya.edu.tr': 'Mühendislik Fakültesi',

    // Fen-Edebiyat Fakültesi
    'math.cankaya.edu.tr': 'Matematik',
    'ell.cankaya.edu.tr': 'İngiliz Dili ve Edebiyatı',
    'psy.cankaya.edu.tr': 'Psikoloji',
    'mtb.cankaya.edu.tr': 'İngilizce Mütercim ve Tercümanlık',
    'bb.cankaya.edu.tr': 'Bilgisayar Bilimleri',               // DÜZELTME: Bankacılık değil!
    'fef.cankaya.edu.tr': 'Fen-Edebiyat Fakültesi',

    // İİBF
    'man.cankaya.edu.tr': 'İşletme',
    'bf.cankaya.edu.tr': 'Bankacılık ve Finans',
    'iktisat.cankaya.edu.tr': 'İktisat',
    'sbu.cankaya.edu.tr': 'Siyaset Bilimi ve Uluslararası İlişkiler',
    'intt.cankaya.edu.tr': 'Uluslararası Ticaret ve Finansman',
    'hir.cankaya.edu.tr': 'Halkla İlişkiler ve Reklamcılık',
    'mis.cankaya.edu.tr': 'Yönetim Bilişim Sistemleri',
    'iibf.cankaya.edu.tr': 'İktisadi ve İdari Bilimler Fakültesi',

    // Hukuk
    'hukuk.cankaya.edu.tr': 'Hukuk Fakültesi',
    'law.cankaya.edu.tr': 'Hukuk Fakültesi',                   // eski kod

    // Mimarlık
    'arch.cankaya.edu.tr': 'Mimarlık',
    'inar.cankaya.edu.tr': 'İç Mimarlık',
    'crp.cankaya.edu.tr': 'Şehir ve Bölge Planlama',
    'mimarlik.cankaya.edu.tr': 'Mimarlık Fakültesi',

    // Enstitüler / Yüksekokullar
    'lee.cankaya.edu.tr': 'Lisansüstü Eğitim Enstitüsü',
    'gs.cankaya.edu.tr': 'Lisansüstü Eğitim',
    'sbe.cankaya.edu.tr': 'Sosyal Bilimler Enstitüsü',
    'fbe.cankaya.edu.tr': 'Fen Bilimleri Enstitüsü',
    'adalet.cankaya.edu.tr': 'Adalet Meslek Yüksekokulu',
    'myo.cankaya.edu.tr': 'Meslek Yüksekokulu',

    // İdari Birimler
    'oim.cankaya.edu.tr': 'Uluslararası İlişkiler Ofisi',
    'kutuphane.cankaya.edu.tr': 'Kütüphane',
    'spor.cankaya.edu.tr': 'Spor Birimi',
    'saglik.cankaya.edu.tr': 'Sağlık Birimi',
    'kariyer.cankaya.edu.tr': 'Kariyer Merkezi',
    'kalite.cankaya.edu.tr': 'Kalite Güvence Birimi',
    'iro.cankaya.edu.tr': 'Uluslararası İlişkiler Ofisi',
    'erasmus.cankaya.edu.tr': 'Erasmus Ofisi',
    'pdrm.cankaya.edu.tr': 'Psikolojik Danışmanlık',
    'odekan.cankaya.edu.tr': 'Öğrenci Dekanlığı',
    'rektorluk.cankaya.edu.tr': 'Rektörlük',
    'genelsekreterlik.cankaya.edu.tr': 'Genel Sekreterlik',
    'bim.cankaya.edu.tr': 'Bilgi İşlem',
    'kariyermezun.cankaya.edu.tr': 'Kariyer-Mezun İlişkileri',
    'kst.cankaya.edu.tr': 'Kalite, Strateji ve Teknoloji Geliştirme',
    'kultur.cankaya.edu.tr': 'Kültür Birimi',
    'yurt.cankaya.edu.tr': 'Öğrenci Yurdu',
    'mevlana.cankaya.edu.tr': 'Mevlana Ofisi',
};

function getDepartmentLabel(hostname) {
    if (HOSTNAME_TO_DEPARTMENT[hostname]) return HOSTNAME_TO_DEPARTMENT[hostname];
    if (hostname.startsWith('en.')) {
        const trHost = hostname.replace('en.', '');
        if (HOSTNAME_TO_DEPARTMENT[trHost]) return HOSTNAME_TO_DEPARTMENT[trHost] + ' (EN)';
    }
    return hostname;
}

// RAG source kayıt
async function ensureRagSource(domain) {
    const { data: existing } = await supabase.from('rag_sources').select('id').eq('url', domain).maybeSingle();
    if (existing) return existing.id;
    const hostname = new URL(domain).hostname;
    const { data: inserted, error } = await supabase
        .from('rag_sources').insert({ url: domain, title: hostname, source_type: 'html', category: 'subdomain' })
        .select('id').single();
    if (error) { console.error(`❌ RAG source eklenemedi:`, error.message); return null; }
    return inserted.id;
}

// Doküman + chunk kayıt
async function saveDocumentAndChunks(sourceId, url, title, text, metadata = {}) {
    const crypto = require('crypto');
    const docId = crypto.createHash('md5').update(url).digest('hex');
    const contentHash = crypto.createHash('md5').update(text).digest('hex');
    const sourceType = metadata.type || 'html';
    const category = metadata.domain || 'cankaya.edu.tr';
    const department = metadata.department || null;

    const chunkMeta = {};
    if (department) chunkMeta.department = department;
    if (metadata.domain) chunkMeta.hostname = metadata.domain;

    const { data: existing } = await supabase.from('rag_documents')
        .select('doc_id, content_hash').eq('doc_id', docId).maybeSingle();

    if (existing) {
        if (existing.content_hash === contentHash) {
            const { count } = await supabase.from('rag_chunks')
                .select('id', { count: 'exact', head: true }).eq('doc_id', docId);
            if (count && count > 0) return 0;
        }
        await supabase.from('rag_documents').update({
            title: title || url, content_hash: contentHash,
            source_type: sourceType, category: category, department: department,
            updated_from_source_at: new Date().toISOString()
        }).eq('doc_id', docId);
    } else {
        const { error: docErr } = await supabase.from('rag_documents').insert({
            doc_id: docId, url, title: title || url,
            source_type: sourceType, category: category,
            department: department, content_hash: contentHash
        });
        if (docErr) { console.error(`   ❌ Doküman eklenemedi: ${docErr.message}`); return 0; }
    }

    await supabase.from('rag_chunks').delete().eq('doc_id', docId);

    const chunks = chunkText(text);
    let savedChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
        const embedding = await getEmbedding(chunks[i]);
        const chunkData = { doc_id: docId, chunk_index: i, chunk_text: chunks[i], metadata: chunkMeta };
        if (embedding) chunkData.embedding = embedding;

        const { error: chunkErr } = await supabase.from('rag_chunks').insert(chunkData);
        if (chunkErr) {
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

// Subdomain crawl
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
    const queue = [{ url: baseUrl, depth: 0 }];
    let totalPages = 0;
    let totalPdfs = 0;
    let totalChunks = 0;

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
            const { htmlLinks, pdfLinks } = extractLinks(html, url);
            for (const link of htmlLinks) {
                const normLink = link.replace(/\/$/, '');
                if (!visited.has(normLink)) queue.push({ url: link, depth: depth + 1 });
            }
            for (const pdfUrl of pdfLinks) pdfQueue.add(pdfUrl);
        }

        await smartDelay(600);
    }

    // PDF'ler
    if (pdfQueue.size > 0) {
        console.log(`   📎 ${pdfQueue.size} PDF bulundu, işleniyor...`);
        for (const pdfUrl of pdfQueue) {
            if (visited.has(pdfUrl)) continue;
            visited.add(pdfUrl);
            const pdfResult = await fetchAndParsePdf(pdfUrl);
            if (!pdfResult || pdfResult.text.length < 100) continue;
            const pdfName = decodeURIComponent(pdfUrl.split('/').pop() || 'document.pdf');
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
            await smartDelay(800);
        }
    }

    console.log(`   ✅ ${hostname}: ${totalPages} HTML + ${totalPdfs} PDF = ${totalChunks} chunk`);
    return { pages: totalPages + totalPdfs, chunks: totalChunks };
}

// Erişilebilirlik kontrolü
async function isSubdomainReachable(hostname) {
    try {
        const res = await axios.get(`https://${hostname}`, {
            timeout: 8000, maxRedirects: 3,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            validateStatus: (s) => s < 500
        });
        return res.status < 400;
    } catch {
        try {
            const res = await axios.get(`http://${hostname}`, {
                timeout: 8000, maxRedirects: 3,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                validateStatus: (s) => s < 500
            });
            return res.status < 400;
        } catch { return false; }
    }
}

// =====================================================
// MAIN — Sadece eksik subdomain'leri tara
// =====================================================
(async () => {
    console.log('🔄 EKSİK Subdomain Crawler Başlatılıyor...');
    console.log(`   ${MISSING_SUBDOMAINS.length} subdomain taranacak\n`);

    let grandTotalPages = 0;
    let grandTotalChunks = 0;
    let reachableCount = 0;

    for (let i = 0; i < MISSING_SUBDOMAINS.length; i++) {
        const hostname = MISSING_SUBDOMAINS[i];
        console.log(`\n[${i + 1}/${MISSING_SUBDOMAINS.length}] ${hostname} kontrol ediliyor...`);

        const reachable = await isSubdomainReachable(hostname);
        if (!reachable) {
            console.log(`   ⏭️ Erişilemiyor, atlanıyor`);
            continue;
        }

        reachableCount++;
        try {
            const result = await crawlSubdomain(`https://${hostname}`);
            if (result) {
                grandTotalPages += result.pages;
                grandTotalChunks += result.chunks;
            }
        } catch (err) {
            console.error(`❌ ${hostname} hata:`, err.message);
        }

        await smartDelay(2000);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Eksik Subdomain Crawl Tamamlandı!`);
    console.log(`   Erişilen: ${reachableCount}/${MISSING_SUBDOMAINS.length}`);
    console.log(`   Toplam: ${grandTotalPages} sayfa/PDF, ${grandTotalChunks} chunk`);
    console.log(`   📊 Embedding: ${successfulEmbeddings} başarılı, ${skippedEmbeddings} atlandı`);
    console.log('='.repeat(60));
})();
