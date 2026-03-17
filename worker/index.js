/**
 * Enginar AI Chat — Cloudflare Worker
 *
 * Akış:
 * 1. Kullanıcı sorusu gelir
 * 2. Rate limit kontrol (kişi başı 20 soru/gün)
 * 3. Soruyu Gemini Embedding ile vektöre çevir
 * 4. Supabase pgvector ile en yakın 5 chunk bul
 * 5. Chunk'ları Groq Llama 3.3 70B'ye gönder (temperature: 0.1)
 * 6. Groq çökerse → Gemini Flash fallback
 * 7. Cevap + kaynak linkler → kullanıcıya
 */

const SYSTEM_PROMPT = `Sen Enginar, Çankaya Üniversitesi öğrencileri için geliştirilmiş bir yapay zeka asistanısın.

KURALLAR:
- SADECE sana verilen kaynaklardan cevap ver. Kaynakta olmayan bilgiyi UYDURMA.
- Bilmiyorsan açıkça "Bu konuda bilgim yok" de.
- Cevabın sonunda kaynak linklerini ver.
- Emin olmadığın bilgiyi kesin gibi sunma.
- Türkçe cevap ver (kullanıcı İngilizce sorarsa İngilizce cevap ver).
- Kısa ve net cevaplar ver, gereksiz uzatma.
- Bölüm/departman bilgilerini karıştırma — her chunk'un başındaki [Bölüm Adı] etiketine dikkat et.

KAYNAK FORMAT:
Cevabın sonunda şu formatta kaynak ver:
📎 Kaynaklar:
- [Sayfa Başlığı](URL)`;

// ─── CORS ───
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── Rate Limiter (KV olmadan, basit in-memory) ───
// Not: Cloudflare Worker'lar stateless, her instance sıfırdan başlar
// Gerçek rate limit için KV veya D1 kullanılabilir ama başlangıç için
// kullanıcı bazlı basit kontrol yeterli
const rateLimitMap = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const dayStart = now - (now % 86400000); // Günün başı (UTC)
  const key = `${userId}_${dayStart}`;

  const count = rateLimitMap.get(key) || 0;
  if (count >= 20) return false; // Günlük 20 soru limiti

  rateLimitMap.set(key, count + 1);

  // Eski kayıtları temizle
  for (const [k] of rateLimitMap) {
    if (!k.endsWith(`_${dayStart}`)) rateLimitMap.delete(k);
  }

  return true;
}

// ─── Gemini Embedding ───
async function getQueryEmbedding(text, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text: text.substring(0, 2000) }] },
        outputDimensionality: 768
      })
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding hatası: ${res.status} - ${err}`);
  }

  const data = await res.json();
  return data.embedding.values;
}

// ─── Supabase Vektör Araması ───
async function searchChunks(embedding, supabaseUrl, supabaseKey, limit = 5) {
  // pgvector cosine similarity ile en yakın chunk'ları bul
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/match_rag_chunks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: limit,
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase arama hatası: ${res.status} - ${err}`);
  }

  return await res.json();
}

// ─── Groq LLM ───
async function askGroq(question, chunks, apiKey) {
  const context = chunks.map((c, i) =>
    `[Kaynak ${i + 1}] ${c.chunk_text}\nURL: ${c.url || 'N/A'}`
  ).join('\n\n---\n\n');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `KAYNAKLAR:\n${context}\n\n---\n\nSORU: ${question}` }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq hatası: ${res.status} - ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ─── Gemini Flash Fallback ───
async function askGemini(question, chunks, apiKey) {
  const context = chunks.map((c, i) =>
    `[Kaynak ${i + 1}] ${c.chunk_text}\nURL: ${c.url || 'N/A'}`
  ).join('\n\n---\n\n');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{
          role: 'user',
          parts: [{ text: `KAYNAKLAR:\n${context}\n\n---\n\nSORU: ${question}` }]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        }
      })
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini hatası: ${res.status} - ${err}`);
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

// ─── Ana Handler ───
async function handleChat(request, env) {
  const { question, user_id } = await request.json();

  if (!question || question.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'Soru boş olamaz' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  if (question.trim().length > 500) {
    return new Response(JSON.stringify({ error: 'Soru çok uzun (max 500 karakter)' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // Rate limit
  const uid = user_id || request.headers.get('CF-Connecting-IP') || 'anonymous';
  if (!checkRateLimit(uid)) {
    return new Response(JSON.stringify({
      error: 'Günlük soru limitine ulaştınız (20/gün). Yarın tekrar deneyin.'
    }), {
      status: 429,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  try {
    // 1. Soruyu embed et
    const embedding = await getQueryEmbedding(question, env.GEMINI_API_KEY);

    // 2. En yakın chunk'ları bul
    const chunks = await searchChunks(embedding, env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    if (!chunks || chunks.length === 0) {
      return new Response(JSON.stringify({
        answer: 'Bu konuda veritabanımda bilgi bulamadım. Lütfen sorunuzu farklı şekilde sormayı deneyin.',
        sources: []
      }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // 3. Kaynak linkleri hazırla
    const sources = [...new Map(chunks.map(c => [c.url, { title: c.title || c.url, url: c.url }])).values()];

    // 4. LLM'e sor (Groq → Gemini fallback)
    let answer;
    try {
      answer = await askGroq(question, chunks, env.GROQ_API_KEY);
    } catch (groqErr) {
      console.log('Groq failed, falling back to Gemini:', groqErr.message);
      answer = await askGemini(question, chunks, env.GEMINI_API_KEY);
    }

    return new Response(JSON.stringify({ answer, sources }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Chat error:', err);
    return new Response(JSON.stringify({
      error: 'Bir hata oluştu. Lütfen tekrar deneyin.',
      debug: err.message
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }
}

// ─── Router ───
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'enginar-chat' }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // Chat endpoint
    if (url.pathname === '/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }
};
