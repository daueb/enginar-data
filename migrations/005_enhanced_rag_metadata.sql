-- Geliştirilmiş RAG metadata desteği
-- match_rag_chunks fonksiyonuna metadata JSONB döndürme eklendi
-- Böylece worker; fakülte, audience, url gibi bilgilere erişebilir

-- Eski fonksiyonları sil (dönüş tipi değiştiği için DROP gerekli)
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
