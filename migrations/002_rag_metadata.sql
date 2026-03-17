-- rag_chunks tablosuna metadata JSONB kolonu ekle
-- Bu kolon department, source_type, course_code, program_id gibi bilgileri tutar
-- AI chatbot bu metadata'yı filtreleme için kullanır

ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';

-- rag_documents tablosuna da department kolonu ekle
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS department text;

-- Metadata üzerinde GIN index (JSONB arama için)
CREATE INDEX IF NOT EXISTS idx_rag_chunks_metadata ON rag_chunks USING gin(metadata);

-- Department üzerinde index (filtreleme için)
CREATE INDEX IF NOT EXISTS idx_rag_documents_department ON rag_documents(department);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_metadata_dept ON rag_chunks ((metadata->>'department'));
