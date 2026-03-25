-- =====================================================
-- Bilgipaketi Veri Tabloları Migration
-- Çankaya Üniversitesi ogbs.cankaya.edu.tr API verileri
-- =====================================================

-- 1. curricula (müfredatlar)
CREATE TABLE IF NOT EXISTS curricula (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id INT NOT NULL,
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    name TEXT,
    name_en TEXT,
    year INT,
    muf_no INT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (program_id, muf_no)
);

-- 2. curriculum_courses (müfredattaki ders slotları)
CREATE TABLE IF NOT EXISTS curriculum_courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    curriculum_id UUID REFERENCES curricula(id) ON DELETE CASCADE,
    course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
    bim_kodu INT,
    year INT,
    semester INT,
    course_code TEXT,
    course_name TEXT,
    course_name_en TEXT,
    theory_hours INT,
    lab_hours INT,
    credit INT,
    ects NUMERIC,
    is_elective BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. course_details (ders detayları)
CREATE TABLE IF NOT EXISTS course_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bim_kodu INT UNIQUE NOT NULL,
    course_code TEXT,
    course_name TEXT,
    course_name_en TEXT,
    language TEXT,
    level TEXT,
    type TEXT,
    delivery TEXT,
    theory_hours INT,
    lab_hours INT,
    credit INT,
    ects NUMERIC,
    description TEXT,
    teaching_methods TEXT,
    textbook TEXT,
    other_resources TEXT,
    prerequisites TEXT,
    corequisites TEXT,
    web_page TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. course_weekly_topics (haftalık konu planı)
CREATE TABLE IF NOT EXISTS course_weekly_topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_detail_id UUID REFERENCES course_details(id) ON DELETE CASCADE,
    week INT NOT NULL,
    topic TEXT
);

-- 5. course_outcomes (ders kazanımları)
CREATE TABLE IF NOT EXISTS course_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_detail_id UUID REFERENCES course_details(id) ON DELETE CASCADE,
    outcome_no INT,
    outcome TEXT
);

-- 6. course_evaluations (değerlendirme kriterleri)
CREATE TABLE IF NOT EXISTS course_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_detail_id UUID REFERENCES course_details(id) ON DELETE CASCADE,
    eval_type TEXT,
    weight_percent INT,
    count INT
);

-- 7. program_info (bölüm bilgi sayfaları)
CREATE TABLE IF NOT EXISTS program_info (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id INT NOT NULL,
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    page_key TEXT NOT NULL,
    content_tr TEXT,
    content_en TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (program_id, page_key)
);

-- 8. program_qualifications (program yeterlilikleri)
CREATE TABLE IF NOT EXISTS program_qualifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id INT NOT NULL,
    qualification_no INT,
    content_tr TEXT,
    content_en TEXT
);

-- İndeksler
CREATE INDEX IF NOT EXISTS idx_curricula_program_id ON curricula(program_id);
CREATE INDEX IF NOT EXISTS idx_curricula_department_id ON curricula(department_id);
CREATE INDEX IF NOT EXISTS idx_curriculum_courses_curriculum_id ON curriculum_courses(curriculum_id);
CREATE INDEX IF NOT EXISTS idx_curriculum_courses_bim_kodu ON curriculum_courses(bim_kodu);
CREATE INDEX IF NOT EXISTS idx_course_details_bim_kodu ON course_details(bim_kodu);
CREATE INDEX IF NOT EXISTS idx_course_details_course_code ON course_details(course_code);
CREATE INDEX IF NOT EXISTS idx_course_weekly_topics_detail_id ON course_weekly_topics(course_detail_id);
CREATE INDEX IF NOT EXISTS idx_course_outcomes_detail_id ON course_outcomes(course_detail_id);
CREATE INDEX IF NOT EXISTS idx_course_evaluations_detail_id ON course_evaluations(course_detail_id);
CREATE INDEX IF NOT EXISTS idx_program_info_program_id ON program_info(program_id);
CREATE INDEX IF NOT EXISTS idx_program_qualifications_program_id ON program_qualifications(program_id);
