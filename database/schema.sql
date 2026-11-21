CREATE DATABASE quizgrader;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exam_papers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
    paper_code VARCHAR(50) NOT NULL,
    title VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(exam_id, paper_code)
);

CREATE TABLE IF NOT EXISTS questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id UUID REFERENCES exam_papers(id) ON DELETE CASCADE,
    question_no INTEGER NOT NULL,
    question_type VARCHAR(30) NOT NULL,
    content TEXT,
    options JSONB DEFAULT '[]',
    UNIQUE(paper_id, question_no, question_type)
);

CREATE TABLE IF NOT EXISTS answer_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
    correct_answer JSONB NOT NULL,
    points NUMERIC(8,3) DEFAULT 0,
    UNIQUE(question_id)
);

CREATE TABLE IF NOT EXISTS students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_code VARCHAR(50),
    full_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id UUID REFERENCES exam_papers(id),
    student_id UUID REFERENCES students(id),
    student_code VARCHAR(50),
    exam_code VARCHAR(50),
    image_path TEXT,
    status VARCHAR(30) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS detected_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID REFERENCES submissions(id) ON DELETE CASCADE,
    question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
    student_answer JSONB,
    confidence NUMERIC(5,4),
    verified BOOLEAN DEFAULT FALSE,
    UNIQUE(submission_id, question_id)
);

CREATE TABLE IF NOT EXISTS grading_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id UUID REFERENCES submissions(id) ON DELETE CASCADE,
    total_questions INTEGER,
    correct_count INTEGER,
    incorrect_count INTEGER,
    blank_count INTEGER,
    total_score NUMERIC(8,3),
    max_score NUMERIC(8,3),
    detail JSONB,
    graded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS uploaded_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
    file_name VARCHAR(255),
    file_path TEXT,
    file_type VARCHAR(30),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_questions_paper
ON questions(paper_id);

CREATE INDEX IF NOT EXISTS idx_submissions_paper
ON submissions(paper_id);

CREATE INDEX IF NOT EXISTS idx_results_submission
ON grading_results(submission_id);

-- ======================================================
-- MIGRATION: chấm bài bằng camera / quét ảnh (OMR)
-- Các lệnh dưới đây an toàn khi chạy lại nhiều lần (IF NOT EXISTS),
-- áp dụng được cho cả database mới lẫn database đã có dữ liệu sẵn.
-- Nếu bạn đang chạy Docker/Render với database ĐÃ TỒN TẠI từ trước,
-- hãy chạy riêng phần migration này (xem RENDER_DEPLOY.md).
-- ======================================================

ALTER TABLE submissions
    ADD COLUMN IF NOT EXISTS detected_student_code VARCHAR(50),
    ADD COLUMN IF NOT EXISTS detected_paper_code VARCHAR(50),
    ADD COLUMN IF NOT EXISTS annotated_image_path TEXT,
    ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'manual';

ALTER TABLE detected_answers
    ADD COLUMN IF NOT EXISTS mark_status VARCHAR(20);

ALTER TABLE grading_results
    ADD COLUMN IF NOT EXISTS ambiguous_count INTEGER DEFAULT 0;

-- Lưu thời điểm chấm (đến từng giây) và ảnh bài thi trực tiếp trong database
ALTER TABLE submissions
    ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS image_data BYTEA,
    ADD COLUMN IF NOT EXISTS annotated_image_data BYTEA;

-- Kỳ thi tự động bị xóa sau 7 ngày (có thể gia hạn)
ALTER TABLE exams
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days');

UPDATE exams SET expires_at = NOW() + INTERVAL '7 days' WHERE expires_at IS NULL;

-- Mã 8 ký tự ngẫu nhiên, dễ nhớ: kỳ thi KT + 6 số, bài làm BL + 6 số
ALTER TABLE exams ADD COLUMN IF NOT EXISTS code VARCHAR(12);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS code VARCHAR(12);

CREATE OR REPLACE FUNCTION random_unique_code(prefix text, tbl text)
RETURNS text AS $$
DECLARE
    c text;
    taken boolean;
BEGIN
    LOOP
        c := prefix || (100000 + floor(random() * 900000))::int::text;

        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE code = $1)', tbl)
            INTO taken USING c;

        EXIT WHEN NOT taken;
    END LOOP;

    RETURN c;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_exam_code() RETURNS trigger AS $$
BEGIN
    IF NEW.code IS NULL THEN
        NEW.code := random_unique_code('KT', 'exams');
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_submission_code() RETURNS trigger AS $$
BEGIN
    IF NEW.code IS NULL THEN
        NEW.code := random_unique_code('BL', 'submissions');
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

ALTER TABLE exams ALTER COLUMN code DROP DEFAULT;
ALTER TABLE submissions ALTER COLUMN code DROP DEFAULT;

DROP TRIGGER IF EXISTS trg_exam_code ON exams;
CREATE TRIGGER trg_exam_code BEFORE INSERT ON exams
    FOR EACH ROW EXECUTE PROCEDURE set_exam_code();

DROP TRIGGER IF EXISTS trg_submission_code ON submissions;
CREATE TRIGGER trg_submission_code BEFORE INSERT ON submissions
    FOR EACH ROW EXECUTE PROCEDURE set_submission_code();

CREATE UNIQUE INDEX IF NOT EXISTS ux_exams_code ON exams(code);
CREATE UNIQUE INDEX IF NOT EXISTS ux_submissions_code ON submissions(code);