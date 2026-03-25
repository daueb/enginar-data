-- =====================================================
-- Eksik unique constraint'leri ekle
-- program_info ve curricula upsert'leri bu constraint'ler
-- olmadan çalışmıyordu (42P10 hatası)
-- =====================================================

-- 1. program_info: (program_id, page_key) unique constraint
-- Önce varsa duplicate'leri temizle
DELETE FROM program_info a
USING program_info b
WHERE a.program_id = b.program_id
  AND a.page_key = b.page_key
  AND a.created_at < b.created_at;

ALTER TABLE program_info
ADD CONSTRAINT program_info_program_id_page_key_unique
UNIQUE (program_id, page_key);

-- 2. curricula: (program_id, muf_no) unique constraint
-- Önce varsa duplicate'leri temizle
DELETE FROM curricula a
USING curricula b
WHERE a.program_id = b.program_id
  AND a.muf_no = b.muf_no
  AND a.created_at < b.created_at;

ALTER TABLE curricula
ADD CONSTRAINT curricula_program_id_muf_no_unique
UNIQUE (program_id, muf_no);

-- 3. match_rag_chunks fonksiyonunu düzelt (rd.id → rd.doc_id)
DROP FUNCTION IF EXISTS match_rag_chunks(vector, double precision, integer);
DROP FUNCTION IF EXISTS match_rag_chunks(vector(768), float, int);

CREATE OR REPLACE FUNCTION match_rag_chunks(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id bigint,
  doc_id text,
  chunk_text text,
  title text,
  url text,
  department text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    rc.id,
    rc.doc_id,
    rc.chunk_text,
    rd.title,
    rd.url,
    COALESCE(rd.department, rc.metadata->>'department', '') as department,
    rc.metadata,
    1 - (rc.embedding <=> query_embedding) as similarity
  FROM rag_chunks rc
  JOIN rag_documents rd ON rd.doc_id = rc.doc_id
  WHERE rc.embedding IS NOT NULL
    AND 1 - (rc.embedding <=> query_embedding) > match_threshold
  ORDER BY rc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
