require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const cheerio = require('cheerio');

// --- GÜVENLİK AYARI ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey) {
    throw new Error("❌ Hata: Supabase URL veya Key eksik!");
}
if (!OPENAI_API_KEY) {
    throw new Error("❌ Hata: OPENAI_API_KEY eksik! .env dosyasına ekleyin.");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const delay = (time) => new Promise(resolve => setTimeout(resolve, time));

// --- AYARLAR ---
const MAX_DEPTH = 2;            // Link takip derinliği
const MAX_PAGES_PER_DOMAIN = 100; // Her subdomain için max sayfa
const CHUNK_SIZE = 500;          // Token başına chunk boyutu (yaklaşık)
const CHUNK_OVERLAP = 50;        // Chunk'lar arası örtüşme

// --- TARANACAK SUBDOMAİNLER ---
const SUBDOMAINS = [
    'https://cankaya.edu.tr',
    'https://oim.cankaya.edu.tr',
    'https://kutuphane.cankaya.edu.tr',
    'https://spor.cankaya.edu.tr',
    'https://iro.cankaya.edu.tr',
    'https://pdrm.cankaya.edu.tr',
    'https://saglik.cankaya.edu.tr',
    'https://kalite.cankaya.edu.tr',
    // Mühendislik bölümleri
    'https://me.cankaya.edu.tr',
    'https://ceng.cankaya.edu.tr',
    'https://ee.cankaya.edu.tr',
    'https://ce.cankaya.edu.tr',
    'https://ie.cankaya.edu.tr',
    // Fen-Edebiyat
    'https://math.cankaya.edu.tr',
    'https://ell.cankaya.edu.tr',
    'https://psy.cankaya.edu.tr',
    'https://mtb.cankaya.edu.tr',
    // İktisadi ve İdari Bilimler
    'https://bb.cankaya.edu.tr',
    'https://econ.cankaya.edu.tr',
    'https://ir.cankaya.edu.tr',
    // Hukuk
    'https://law.cankaya.edu.tr',
    // Mimarlık
    'https://arch.cankaya.edu.tr',
    'https://id.cankaya.edu.tr',
    // Diğer
    'https://sks.cankaya.edu.tr',
    'https://oidb.cankaya.edu.tr',
    'https://kariyer.cankaya.edu.tr',
];

// Atlanacak uzantılar
const SKIP_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mp3|wav|zip|rar|doc|docx|xls|xlsx|ppt|pptx|exe|dmg)$/i;

// =====================================================
// EMBEDDING FONKSİYONU
// =====================================================
async function getEmbedding(text) {
    try {
        const res = await axios.post('https://api.openai.com/v1/embeddings', {
            model: 'text-embedding-3-small',
            input: text
        }, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return res.data.data[0].embedding;
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
        if (chunk.length > 30) { // Çok kısa chunk'ları atla
            chunks.push(chunk);
        }
        start += chunkSize - overlap;
    }

    return chunks;
}

// =====================================================
// HTML → TEMİZ METİN
// =====================================================
function htmlToText(html) {
    const $ = cheerio.load(html);

    // Script, style, nav, footer, header gibi gereksiz elementleri kaldır
    $('script, style, nav, footer, header, iframe, noscript, .menu, .sidebar, .navigation, .breadcrumb').remove();

    // Metin çıkar
    let text = $('body').text() || $.text();

    // Temizle
    text = text
        .replace(/\t/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/ {2,}/g, ' ')
        .trim();

    return text;
}

// =====================================================
// SAYFA CRAWL
// =====================================================
async function fetchPage(url) {
    try {
        const res = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'EnginarBot/1.0 (Cankaya University Campus App Data Collector)',
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
        // Sessiz ol, bazı sayfalar 404 dönecek
        return null;
    }
}

// =====================================================
// LINK ÇIKARMA
// =====================================================
function extractLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const links = new Set();
    const baseHost = new URL(baseUrl).hostname;

    $('a[href]').each((_, el) => {
        let href = $(el).attr('href');
        if (!href) return;

        // Anchor ve javascript linklerini atla
        if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

        // Dosya uzantılarını atla
        if (SKIP_EXTENSIONS.test(href)) return;

        try {
            const fullUrl = new URL(href, baseUrl);
            // Sadece aynı hostname'deki linkler
            if (fullUrl.hostname === baseHost && fullUrl.protocol.startsWith('http')) {
                // Query string ve hash'i temizle
                fullUrl.hash = '';
                links.add(fullUrl.href);
            }
        } catch {
            // Geçersiz URL, atla
        }
    });

    return links;
}

// =====================================================
// RAG SOURCE KAYDI
// =====================================================
async function ensureRagSource(domain) {
    const { data: existing } = await supabase
        .from('rag_sources')
        .select('id')
        .eq('url', domain)
        .maybeSingle();

    if (existing) return existing.id;

    const { data: inserted, error } = await supabase
        .from('rag_sources')
        .insert({
            url: domain,
            name: new URL(domain).hostname,
            type: 'website',
            status: 'active'
        })
        .select('id')
        .single();

    if (error) {
        console.error(`❌ RAG source eklenemedi (${domain}):`, error.message);
        return null;
    }
    return inserted.id;
}

// =====================================================
// DOKÜMAN + CHUNK KAYDI
// =====================================================
async function saveDocumentAndChunks(sourceId, url, title, text, metadata = {}) {
    // rag_documents'a kaydet
    const { data: docData, error: docErr } = await supabase
        .from('rag_documents')
        .upsert({
            source_id: sourceId,
            url: url,
            title: title || url,
            content: text.substring(0, 50000), // Max 50K karakter
            metadata: metadata,
            status: 'processed'
        }, { onConflict: 'url' })
        .select('id')
        .single();

    let docId = docData?.id;
    if (docErr || !docId) {
        const { data: existing } = await supabase.from('rag_documents')
            .select('id')
            .eq('url', url)
            .maybeSingle();
        docId = existing?.id;

        if (!docId) {
            const { data: ins } = await supabase.from('rag_documents')
                .insert({
                    source_id: sourceId,
                    url: url,
                    title: title || url,
                    content: text.substring(0, 50000),
                    metadata: metadata,
                    status: 'processed'
                })
                .select('id')
                .single();
            docId = ins?.id;
        }
    }

    if (!docId) return 0;

    // Eski chunk'ları temizle
    await supabase.from('rag_chunks').delete().eq('document_id', docId);

    // Chunk'la ve embedding al
    const chunks = chunkText(text);
    let savedChunks = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await getEmbedding(chunk);
        if (!embedding) continue;

        const { error: chunkErr } = await supabase.from('rag_chunks').insert({
            document_id: docId,
            chunk_index: i,
            content: chunk,
            embedding: embedding,
            metadata: { ...metadata, chunk_index: i, total_chunks: chunks.length }
        });

        if (!chunkErr) savedChunks++;
        await delay(100); // OpenAI rate limit
    }

    return savedChunks;
}

// =====================================================
// BİR SUBDOMAİN'İ TARA
// =====================================================
async function crawlSubdomain(baseUrl) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🌐 Taranıyor: ${baseUrl}`);
    console.log('─'.repeat(50));

    const sourceId = await ensureRagSource(baseUrl);
    if (!sourceId) return;

    const visited = new Set();
    const queue = [{ url: baseUrl, depth: 0 }];
    let totalPages = 0;
    let totalChunks = 0;

    while (queue.length > 0 && totalPages < MAX_PAGES_PER_DOMAIN) {
        const { url, depth } = queue.shift();

        // Zaten ziyaret edildiyse atla
        const normalizedUrl = url.replace(/\/$/, '');
        if (visited.has(normalizedUrl)) continue;
        visited.add(normalizedUrl);

        // Sayfayı çek
        const html = await fetchPage(url);
        if (!html) continue;

        // Metin çıkar
        const $ = cheerio.load(html);
        const title = $('title').text().trim() || url;
        const text = htmlToText(html);

        // Çok kısa sayfaları atla (genelde boş veya redirect)
        if (text.length < 100) continue;

        // Kaydet + vektörize
        const chunkCount = await saveDocumentAndChunks(sourceId, url, title, text, {
            source: 'subdomain_crawl',
            domain: new URL(baseUrl).hostname
        });

        totalPages++;
        totalChunks += chunkCount;
        console.log(`   📄 [${totalPages}] ${title.substring(0, 50)}... (${chunkCount} chunk)`);

        // Derinlik kontrolü - alt linkleri kuyruğa ekle
        if (depth < MAX_DEPTH) {
            const links = extractLinks(html, url);
            for (const link of links) {
                const normLink = link.replace(/\/$/, '');
                if (!visited.has(normLink)) {
                    queue.push({ url: link, depth: depth + 1 });
                }
            }
        }

        await delay(300); // Sunucuyu yormamak için
    }

    console.log(`   ✅ ${baseUrl}: ${totalPages} sayfa, ${totalChunks} chunk kaydedildi`);
    return { pages: totalPages, chunks: totalChunks };
}

// =====================================================
// ANA FONKSİYON
// =====================================================
(async () => {
    console.log('🔄 Subdomain Crawler + RAG Vektörize Başlatılıyor...\n');

    let grandTotalPages = 0;
    let grandTotalChunks = 0;

    for (const subdomain of SUBDOMAINS) {
        try {
            const result = await crawlSubdomain(subdomain);
            if (result) {
                grandTotalPages += result.pages;
                grandTotalChunks += result.chunks;
            }
        } catch (err) {
            console.error(`❌ ${subdomain} taranırken hata:`, err.message);
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Subdomain Crawl Tamamlandı!`);
    console.log(`   Toplam: ${grandTotalPages} sayfa, ${grandTotalChunks} chunk`);
    console.log('='.repeat(60));
})();
