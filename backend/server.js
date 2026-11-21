require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const db = require("./db");
const { gradeExam } = require("./grading");

const mammoth = require("mammoth");
const pdf = require("pdf-parse");
const ExcelJS = require("exceljs");
const Jimp = require("jimp");

const {
    parseRowsForAnswerKey,
    parseFlatTextForAnswerKey,
    extractTableRowsFromHtml
} = require("./importers/answerKeyParser");

const omrTemplate = require("./omr/template");
const { detectMarkers } = require("./omr/markerDetect");
const { computeHomography, warpToReference } = require("./omr/geometry");
const { readSBD, readMaDe, readQuestions } = require("./omr/bubbleRead");
const { annotateImage } = require("./omr/annotate");
const { chooseOrientation, MIN_PASSED } = require("./omr/alignCheck");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Cho phép dùng MÃ NGẮN thay cho UUID ở mọi đường dẫn có :id
//   KT483921 -> kỳ thi,  BL274058 -> bài làm  (không phân biệt hoa/thường)
app.param("id", async (req, res, next, value) => {
    try {
        const code = String(value).trim().toUpperCase();

        let table = null;

        if (/^KT\d{6}$/.test(code)) table = "exams";
        else if (/^BL\d{6}$/.test(code)) table = "submissions";

        if (!table) return next();

        const found = await db.query(
            `SELECT id FROM ${table} WHERE code = $1`,
            [code]
        );

        if (!found.rowCount) {
            return res.status(404).json({ error: `Không tìm thấy mã ${code}` });
        }

        req.params.id = found.rows[0].id;

        next();
    } catch (error) {
        next(error);
    }
});

// Thư mục lưu file tải lên
const uploadDir = path.resolve(
    process.env.UPLOAD_DIR || "backend/uploads"
);

const annotatedDir = path.join(uploadDir, "annotated");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(annotatedDir, { recursive: true });

// Cấu hình lưu file
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },

    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);

        cb(
            null,
            `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`
        );
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: 20 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {
        const allowed = [
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".pdf",
            ".docx",
            ".doc",
            ".xlsx"
        ];

        if (
            allowed.includes(
                path.extname(file.originalname).toLowerCase()
            )
        ) {
            cb(null, true);
        } else {
            cb(new Error("File không được hỗ trợ"));
        }
    }
});

// Xử lý bất đồng bộ cho các API
function asyncRoute(handler) {
    return (req, res, next) => {
        Promise.resolve(
            handler(req, res, next)
        ).catch(next);
    };
}

// ======================================================
// 1. KIỂM TRA API VÀ DATABASE
// ======================================================

app.get(
    "/api/health",
    asyncRoute(async (req, res) => {
        await db.query("SELECT 1");

        res.json({
            status: "ok",
            database: "connected"
        });
    })
);

// ======================================================
// 2. DANH SÁCH KỲ THI
// ======================================================

// Dung lượng mỗi kỳ thi = ảnh lưu trong DB + kết quả chấm + câu hỏi +
// các file còn nằm trên đĩa (bài cũ chưa lưu ảnh vào DB, file đề đã tải lên).
async function fileSize(filePath) {
    try {
        if (!filePath) return 0;

        return (await fs.promises.stat(path.resolve(filePath))).size;
    } catch (e) {
        return 0;
    }
}

async function computeExamStorage() {
    const sizes = new Map(); // exam_id -> {bytes, submissions}

    const ensure = id => {
        if (!sizes.has(id)) sizes.set(id, { bytes: 0, submissions: 0 });

        return sizes.get(id);
    };

    const dbRows = await db.query(`
        SELECT
            p.exam_id,
            COUNT(s.id)::int AS submissions,
            COALESCE(SUM(
                COALESCE(octet_length(s.image_data), 0) +
                COALESCE(octet_length(s.annotated_image_data), 0)
            ), 0)::bigint AS image_bytes,
            COALESCE(SUM(
                (SELECT COALESCE(SUM(pg_column_size(g.detail)), 0)
                 FROM grading_results g WHERE g.submission_id = s.id)
            ), 0)::bigint AS result_bytes
        FROM exam_papers p
        LEFT JOIN submissions s ON s.paper_id = p.id
        GROUP BY p.exam_id
    `);

    for (const r of dbRows.rows) {
        const e = ensure(r.exam_id);

        e.submissions = r.submissions;
        e.bytes += Number(r.image_bytes) + Number(r.result_bytes);
    }

    const questionRows = await db.query(`
        SELECT p.exam_id,
               COALESCE(SUM(pg_column_size(q.*)), 0)::bigint AS bytes
        FROM exam_papers p
        JOIN questions q ON q.paper_id = p.id
        GROUP BY p.exam_id
    `);

    for (const r of questionRows.rows) ensure(r.exam_id).bytes += Number(r.bytes);

    // File còn trên đĩa: bài chưa có ảnh trong DB
    const legacy = await db.query(`
        SELECT p.exam_id, s.image_path, s.annotated_image_path,
               s.image_data IS NULL AS no_img,
               s.annotated_image_data IS NULL AS no_ann
        FROM submissions s
        JOIN exam_papers p ON p.id = s.paper_id
        WHERE s.image_data IS NULL OR s.annotated_image_data IS NULL
    `);

    for (const r of legacy.rows) {
        const e = ensure(r.exam_id);

        if (r.no_img) e.bytes += await fileSize(r.image_path);
        if (r.no_ann) e.bytes += await fileSize(r.annotated_image_path);
    }

    const uploaded = await db.query(
        "SELECT exam_id, file_path FROM uploaded_files"
    );

    for (const r of uploaded.rows) {
        ensure(r.exam_id).bytes += await fileSize(r.file_path);
    }

    return sizes;
}

app.get(
    "/api/exams",
    asyncRoute(async (req, res) => {
        const result = await db.query(
            "SELECT * FROM exams ORDER BY created_at DESC"
        );

        // ?light=1: chỉ lấy hạn xóa (nhẹ), bỏ qua tính dung lượng
        if (req.query.light) {
            return res.json(result.rows);
        }

        const sizes = await computeExamStorage();

        res.json(
            result.rows.map(exam => {
                const info = sizes.get(exam.id) || { bytes: 0, submissions: 0 };

                return {
                    ...exam,
                    storage_bytes: info.bytes,
                    submission_count: info.submissions
                };
            })
        );
    })
);

// ======================================================
// 3. TẠO KỲ THI
// ======================================================

app.post(
    "/api/exams",
    asyncRoute(async (req, res) => {
        const { name, description } = req.body;

        if (!name?.trim()) {
            return res.status(400).json({
                error: "Thiếu tên kỳ thi"
            });
        }

        const result = await db.query(
            `INSERT INTO exams(name, description)
             VALUES($1, $2)
             RETURNING *`,
            [
                name.trim(),
                description || ""
            ]
        );

        res.status(201).json(result.rows[0]);
    })
);

// ======================================================
// 4. XÓA KỲ THI VÀ TOÀN BỘ DỮ LIỆU LIÊN QUAN
// ======================================================

// Xóa toàn bộ dữ liệu của 1 kỳ thi (dùng cho nút Xóa và cho tự động xóa
// khi hết hạn). Trả về false nếu kỳ thi không tồn tại.
async function purgeExam(id) {
    const client = await db.pool.connect();

    let filesToDelete = [];

    try {
        await client.query("BEGIN");

        const examResult = await client.query(
            "SELECT id FROM exams WHERE id = $1 FOR UPDATE",
            [id]
        );

        if (examResult.rowCount === 0) {
            await client.query("ROLLBACK");

            return false;
        }

        // Gom đường dẫn file trên đĩa để xóa sau khi COMMIT thành công
        const fileRows = await client.query(
            `
            SELECT s.image_path AS p1, s.annotated_image_path AS p2
            FROM submissions s
            JOIN exam_papers p ON p.id = s.paper_id
            WHERE p.exam_id = $1
            `,
            [id]
        );

        const uploadedRows = await client.query(
            "SELECT file_path FROM uploaded_files WHERE exam_id = $1",
            [id]
        );

        filesToDelete = [
            ...fileRows.rows.flatMap(r => [r.p1, r.p2]),
            ...uploadedRows.rows.map(r => r.file_path)
        ].filter(Boolean);

        const bySubmission = `
            SELECT s.id
            FROM submissions s
            JOIN exam_papers p ON p.id = s.paper_id
            WHERE p.exam_id = $1
        `;

        await client.query(
            `DELETE FROM grading_results WHERE submission_id IN (${bySubmission})`,
            [id]
        );

        await client.query(
            `DELETE FROM detected_answers WHERE submission_id IN (${bySubmission})`,
            [id]
        );

        await client.query(
            `
            DELETE FROM submissions
            WHERE paper_id IN (SELECT id FROM exam_papers WHERE exam_id = $1)
            `,
            [id]
        );

        await client.query(
            `
            DELETE FROM answer_keys
            WHERE question_id IN (
                SELECT q.id
                FROM questions q
                JOIN exam_papers p ON p.id = q.paper_id
                WHERE p.exam_id = $1
            )
            `,
            [id]
        );

        await client.query(
            `
            DELETE FROM questions
            WHERE paper_id IN (SELECT id FROM exam_papers WHERE exam_id = $1)
            `,
            [id]
        );

        await client.query("DELETE FROM uploaded_files WHERE exam_id = $1", [id]);
        await client.query("DELETE FROM exam_papers WHERE exam_id = $1", [id]);
        await client.query("DELETE FROM exams WHERE id = $1", [id]);

        await client.query("COMMIT");

    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});

        throw error;

    } finally {
        client.release();
    }

    // Xóa file trên đĩa (không bắt buộc, lỗi thì bỏ qua)
    await Promise.all(
        filesToDelete.map(f =>
            fs.promises.unlink(path.resolve(f)).catch(() => {})
        )
    );

    return true;
}

app.delete(
    "/api/exams/:id",
    asyncRoute(async (req, res) => {
        const deleted = await purgeExam(req.params.id);

        if (!deleted) {
            return res.status(404).json({ error: "Không tìm thấy kỳ thi" });
        }

        res.json({
            message: "Đã xóa kỳ thi và toàn bộ dữ liệu liên quan"
        });
    })
);

// Gia hạn thêm N ngày (mặc định 7) tính từ hạn hiện tại, hoặc từ bây giờ
// nếu đã quá hạn.
app.post(
    "/api/exams/:id/extend",
    asyncRoute(async (req, res) => {
        const days = Math.min(
            30,
            Math.max(1, Number((req.body || {}).days) || 7)
        );

        const result = await db.query(
            `
            UPDATE exams
            SET expires_at =
                GREATEST(COALESCE(expires_at, NOW()), NOW())
                + ($2::int * INTERVAL '1 day')
            WHERE id = $1
            RETURNING id, expires_at
            `,
            [req.params.id, days]
        );

        if (!result.rowCount) {
            return res.status(404).json({ error: "Không tìm thấy kỳ thi" });
        }

        res.json(result.rows[0]);
    })
);

// Tự động xóa các kỳ thi đã hết hạn
async function purgeExpiredExams() {
    const expired = await db.query(`
        SELECT id, name FROM exams
        WHERE expires_at IS NOT NULL AND expires_at < NOW()
    `);

    for (const exam of expired.rows) {
        try {
            await purgeExam(exam.id);

            console.log(`Đã tự động xóa kỳ thi hết hạn: ${exam.name} (${exam.id})`);
        } catch (error) {
            console.error(`Không xóa được kỳ thi ${exam.id}:`, error.message);
        }
    }
}

// ======================================================
// 5. TẠO MÃ ĐỀ
// ======================================================

app.post(
    "/api/papers",
    asyncRoute(async (req, res) => {
        const {
            exam_id,
            paper_code,
            title
        } = req.body;

        const result = await db.query(
            `
            INSERT INTO exam_papers(exam_id, paper_code, title)
            VALUES($1, $2, $3)
            RETURNING *
            `,
            [
                exam_id,
                paper_code,
                title || ""
            ]
        );

        res.status(201).json(result.rows[0]);
    })
);

// ======================================================
// 6. DANH SÁCH MÃ ĐỀ
// ======================================================

app.get(
    "/api/exams/:id/papers",
    asyncRoute(async (req, res) => {
        const result = await db.query(
            `
            SELECT *
            FROM exam_papers
            WHERE exam_id = $1
            ORDER BY paper_code
            `,
            [req.params.id]
        );

        res.json(result.rows);
    })
);

// ======================================================
// 7. THÊM CÂU HỎI VÀ ĐÁP ÁN
// ======================================================

app.post(
    "/api/papers/:id/questions",
    asyncRoute(async (req, res) => {
        const {
            question_no,
            question_type,
            content,
            options,
            correct_answer,
            points
        } = req.body;

        const validTypes = [
            "MCQ",
            "TRUE_FALSE"
        ];

        if (!validTypes.includes(question_type)) {
            return res.status(400).json({
                error: "Loại câu hỏi không hợp lệ"
            });
        }

        if (
            correct_answer === undefined ||
            correct_answer === null
        ) {
            return res.status(400).json({
                error: "Thiếu đáp án chuẩn"
            });
        }

        const client = await db.pool.connect();

        try {
            await client.query("BEGIN");

            const question = await client.query(
                `
                INSERT INTO questions(
                    paper_id,
                    question_no,
                    question_type,
                    content,
                    options
                )
                VALUES($1, $2, $3, $4, $5)
                RETURNING *
                `,
                [
                    req.params.id,
                    question_no,
                    question_type,
                    content || "",
                    JSON.stringify(options || [])
                ]
            );

            await client.query(
                `
                INSERT INTO answer_keys(
                    question_id,
                    correct_answer,
                    points
                )
                VALUES($1, $2, $3)
                `,
                [
                    question.rows[0].id,
                    JSON.stringify(correct_answer),
                    points ?? 0.25
                ]
            );

            await client.query("COMMIT");

            res.status(201).json(question.rows[0]);

        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});

            throw error;

        } finally {
            client.release();
        }
    })
);

// ======================================================
// 7B. NHẬP ĐÁP ÁN HÀNG LOẠT (thêm mới hoặc ghi đè nếu đã có)
// ======================================================

const QUESTION_TYPES = ["MCQ", "TRUE_FALSE"];

app.post(
    "/api/papers/:id/questions/bulk",
    asyncRoute(async (req, res) => {
        const { questions } = req.body;

        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({
                error: "Danh sách câu hỏi trống"
            });
        }

        // Kiểm tra toàn bộ trước khi ghi, để không lưu dở dang
        for (const [index, item] of questions.entries()) {
            const no = Number(item.question_no);
            const points = Number(item.points);

            if (!QUESTION_TYPES.includes(item.question_type)) {
                return res.status(400).json({
                    error: `Câu thứ ${index + 1}: loại câu hỏi không hợp lệ`
                });
            }

            if (!Number.isInteger(no) || no < 1) {
                return res.status(400).json({
                    error: `Câu thứ ${index + 1}: số câu không hợp lệ`
                });
            }

            if (
                item.correct_answer === undefined ||
                item.correct_answer === null ||
                item.correct_answer === ""
            ) {
                return res.status(400).json({
                    error: `${item.question_type === "MCQ" ? "Phần I" : "Phần II"} - câu ${no}: thiếu đáp án`
                });
            }

            if (!Number.isFinite(points) || points < 0) {
                return res.status(400).json({
                    error: `Câu thứ ${index + 1}: điểm không hợp lệ`
                });
            }
        }

        const paper = await db.query(
            "SELECT id FROM exam_papers WHERE id = $1",
            [req.params.id]
        );

        if (!paper.rowCount) {
            return res.status(404).json({
                error: "Không tìm thấy mã đề"
            });
        }

        const client = await db.pool.connect();

        try {
            await client.query("BEGIN");

            let saved = 0;

            for (const item of questions) {
                const question = await client.query(
                    `
                    INSERT INTO questions(
                        paper_id,
                        question_no,
                        question_type,
                        content,
                        options
                    )
                    VALUES($1, $2, $3, $4, $5)
                    ON CONFLICT (paper_id, question_no, question_type)
                    DO UPDATE SET content = EXCLUDED.content
                    RETURNING id
                    `,
                    [
                        req.params.id,
                        item.question_no,
                        item.question_type,
                        item.content || "",
                        JSON.stringify(item.options || [])
                    ]
                );

                await client.query(
                    `
                    INSERT INTO answer_keys(
                        question_id,
                        correct_answer,
                        points
                    )
                    VALUES($1, $2, $3)
                    ON CONFLICT (question_id)
                    DO UPDATE SET
                        correct_answer = EXCLUDED.correct_answer,
                        points = EXCLUDED.points
                    `,
                    [
                        question.rows[0].id,
                        JSON.stringify(item.correct_answer),
                        item.points ?? 0.25
                    ]
                );

                saved++;
            }

            await client.query("COMMIT");

            res.status(201).json({
                message: `Đã lưu ${saved} câu`,
                saved
            });

        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});

            throw error;

        } finally {
            client.release();
        }
    })
);

// ======================================================
// 8. DANH SÁCH CÂU HỎI VÀ ĐÁP ÁN
// ======================================================

app.get(
    "/api/papers/:id/questions",
    asyncRoute(async (req, res) => {
        const result = await db.query(
            `
            SELECT
                q.id,
                q.question_no,
                q.question_type,
                q.content,
                q.options,
                a.correct_answer,
                a.points
            FROM questions q
            JOIN answer_keys a ON a.question_id = q.id
            WHERE q.paper_id = $1
            ORDER BY q.question_type, q.question_no
            `,
            [req.params.id]
        );

        res.json(result.rows);
    })
);

// ======================================================
// 9. TẢI ẢNH PHIẾU TRẢ LỜI
// ======================================================

app.post(
    "/api/submissions/upload",
    upload.single("file"),
    asyncRoute(async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                error: "Chưa tải file"
            });
        }

        const {
            paper_id,
            student_code,
            exam_code
        } = req.body;

        const paper = await db.query(
            "SELECT id FROM exam_papers WHERE id = $1",
            [paper_id]
        );

        if (!paper.rowCount) {
            return res.status(404).json({
                error: "Không tìm thấy mã đề"
            });
        }

        const filePath = path.relative(
            path.resolve("."),
            req.file.path
        ).replace(/\\/g, "/");

        const result = await db.query(
            `
            INSERT INTO submissions(
                paper_id,
                student_code,
                exam_code,
                image_path,
                status
            )
            VALUES($1, $2, $3, $4, 'pending')
            RETURNING *
            `,
            [
                paper_id,
                student_code || null,
                exam_code || null,
                filePath
            ]
        );

        res.status(201).json({
            message: "Đã tiếp nhận phiếu. Cần kiểm tra đáp án nhận diện.",
            submission: result.rows[0]
        });
    })
);

// ======================================================
// 10. ĐỌC ĐÁP ÁN TỪ WORD / EXCEL / PDF
// ======================================================
//
// Đọc tự động cả Phần I (trắc nghiệm A-D) và Phần II (Đúng/Sai, mỗi câu
// 1 đáp án duy nhất) theo bảng dạng "Câu / Đáp án" (xem
// backend/importers/answerKeyParser.js). Loại câu hỏi được suy ra từ chính
// giá trị đọc được: A/B/C/D -> Phần I; Đúng/Sai/Đ/S -> Phần II. Chữ "D"
// một mình luôn là đáp án D của Phần I, không bao giờ bị hiểu là "Đúng".
// Kết quả trả về CHƯA được lưu vào CSDL — phía giao diện phải đổ vào khung
// nhập hàng loạt để giáo viên xem lại, sửa nếu cần, rồi mới bấm Lưu.

async function extractXlsxRows(filePath) {
    const workbook = new ExcelJS.Workbook();

    await workbook.xlsx.readFile(filePath);

    const worksheet = workbook.worksheets[0];

    if (!worksheet) return [];

    const rows = [];

    worksheet.eachRow({ includeEmpty: false }, excelRow => {
        const cells = [];

        excelRow.eachCell({ includeEmpty: true }, cell => {
            cells.push(
                cell.value === null || cell.value === undefined
                    ? ""
                    : String(cell.text ?? cell.value).trim()
            );
        });

        // Bỏ các ô trống thừa ở cuối hàng (Excel hay có)
        while (cells.length && !cells[cells.length - 1]) cells.pop();

        if (cells.length > 0) rows.push(cells);
    });

    return rows;
}

app.post(
    "/api/documents/parse-answer-key",
    upload.single("file"),
    asyncRoute(async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                error: "Chưa tải tài liệu"
            });
        }

        const ext = path.extname(req.file.originalname).toLowerCase();

        try {
            let parseResult;
            let rawPreview = "";

            if (ext === ".xlsx") {
                const rows = await extractXlsxRows(req.file.path);

                rawPreview = rows
                    .slice(0, 20)
                    .map(r => r.join(" | "))
                    .join("\n");

                parseResult = parseRowsForAnswerKey(rows);

            } else if (ext === ".docx") {
                const htmlResult = await mammoth.convertToHtml({
                    path: req.file.path
                });

                const tableRows = extractTableRowsFromHtml(htmlResult.value);

                if (tableRows.length > 0) {
                    rawPreview = tableRows
                        .slice(0, 20)
                        .map(r => r.join(" | "))
                        .join("\n");

                    parseResult = parseRowsForAnswerKey(tableRows);

                } else {
                    const textResult = await mammoth.extractRawText({
                        path: req.file.path
                    });

                    rawPreview = textResult.value.slice(0, 2000);
                    parseResult = parseFlatTextForAnswerKey(textResult.value);
                }

            } else if (ext === ".pdf") {
                const buffer = fs.readFileSync(req.file.path);
                const pdfResult = await pdf(buffer);

                rawPreview = pdfResult.text.slice(0, 2000);
                parseResult = parseFlatTextForAnswerKey(pdfResult.text);

            } else {
                return res.status(400).json({
                    error: "Chỉ hỗ trợ file DOCX, XLSX hoặc PDF ở chức năng này"
                });
            }

            res.json({
                file_name: req.file.originalname,
                answers: parseResult.answers,
                warnings: parseResult.warnings,
                raw_preview: rawPreview
            });

        } catch (error) {
            res.status(422).json({
                error: "Không đọc được tài liệu",
                detail: error.message
            });
        }
    })
);

// ======================================================
// 11. LƯU ĐÁP ÁN BÀI LÀM ĐÃ XÁC NHẬN
// ======================================================

app.post(
    "/api/submissions/:id/answers",
    asyncRoute(async (req, res) => {
        const { answers } = req.body;

        if (
            !answers ||
            typeof answers !== "object"
        ) {
            return res.status(400).json({
                error: "Đáp án không hợp lệ"
            });
        }

        const submission = await db.query(
            `
            SELECT id, paper_id
            FROM submissions
            WHERE id = $1
            `,
            [req.params.id]
        );

        if (!submission.rowCount) {
            return res.status(404).json({
                error: "Không tìm thấy bài làm"
            });
        }

        const questions = await db.query(
            "SELECT id FROM questions WHERE paper_id = $1",
            [submission.rows[0].paper_id]
        );

        const client = await db.pool.connect();

        try {
            await client.query("BEGIN");

            for (const question of questions.rows) {
                if (
                    !Object.prototype.hasOwnProperty.call(
                        answers,
                        question.id
                    )
                ) {
                    continue;
                }

                await client.query(
                    `
                    INSERT INTO detected_answers(
                        submission_id,
                        question_id,
                        student_answer,
                        verified
                    )
                    VALUES($1, $2, $3, TRUE)
                    ON CONFLICT(submission_id, question_id)
                    DO UPDATE SET
                        student_answer = EXCLUDED.student_answer,
                        verified = TRUE
                    `,
                    [
                        req.params.id,
                        question.id,
                        JSON.stringify(answers[question.id])
                    ]
                );
            }

            await client.query(
                `
                UPDATE submissions
                SET status = 'verified'
                WHERE id = $1
                `,
                [req.params.id]
            );

            await client.query("COMMIT");

            res.json({
                message: "Đã lưu đáp án xác nhận"
            });

        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});

            throw error;

        } finally {
            client.release();
        }
    })
);

// ======================================================
// 12. CHẤM ĐIỂM
// ======================================================

app.post(
    "/api/submissions/:id/grade",
    asyncRoute(async (req, res) => {
        const submission = await db.query(
            `
            SELECT id, paper_id, status
            FROM submissions
            WHERE id = $1
            `,
            [req.params.id]
        );

        if (!submission.rowCount) {
            return res.status(404).json({
                error: "Không tìm thấy bài làm"
            });
        }

        if (submission.rows[0].status !== "verified") {
            return res.status(409).json({
                error: "Cần xác nhận đáp án trước khi chấm"
            });
        }

        const paperId = submission.rows[0].paper_id;

        const questions = await db.query(
            `
            SELECT
                q.id,
                q.question_no,
                q.question_type,
                a.correct_answer,
                a.points
            FROM questions q
            JOIN answer_keys a ON a.question_id = q.id
            WHERE q.paper_id = $1
            ORDER BY q.question_no
            `,
            [paperId]
        );

        const studentAnswers = await db.query(
            `
            SELECT question_id, student_answer
            FROM detected_answers
            WHERE submission_id = $1
            AND verified = TRUE
            `,
            [req.params.id]
        );

        const answers = {};

        studentAnswers.rows.forEach(row => {
            answers[row.question_id] = row.student_answer;
        });

        const result = gradeExam(
            questions.rows,
            answers
        );

        await db.query(
            `
            INSERT INTO grading_results(
                submission_id,
                total_questions,
                correct_count,
                incorrect_count,
                blank_count,
                total_score,
                max_score,
                detail
            )
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            `,
            [
                req.params.id,
                result.total_questions,
                result.correct_count,
                result.incorrect_count,
                result.blank_count,
                result.total_score,
                result.max_score,
                JSON.stringify(result.details)
            ]
        );

        await db.query(
            `
            UPDATE submissions
            SET status = 'graded'
            WHERE id = $1
            `,
            [req.params.id]
        );

        res.json(result);
    })
);

// ======================================================
// 13. DANH SÁCH BÀI LÀM THEO MÃ ĐỀ
// ======================================================

app.get(
    "/api/papers/:id/submissions",
    asyncRoute(async (req, res) => {
        const result = await db.query(
            `
            SELECT
                id,
                student_code,
                exam_code,
                status,
                created_at
            FROM submissions
            WHERE paper_id = $1
            ORDER BY created_at DESC
            `,
            [req.params.id]
        );

        res.json(result.rows);
    })
);

// ======================================================
// 14. XEM KẾT QUẢ
// ======================================================

app.get(
    "/api/results/:id",
    asyncRoute(async (req, res) => {
        const result = await db.query(
            `
            SELECT
                r.*,
                s.code AS submission_code,
                s.student_code,
                s.exam_code
            FROM grading_results r
            JOIN submissions s ON s.id = r.submission_id
            WHERE r.submission_id = $1
            ORDER BY r.graded_at DESC
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                error: "Chưa có kết quả"
            });
        }

        res.json(result.rows[0]);
    })
);

// ======================================================
// 15. XUẤT EXCEL
// ======================================================

app.get(
    "/api/results/:id/excel",
    asyncRoute(async (req, res) => {
        const result = await db.query(
            `
            SELECT
                r.*,
                s.student_code,
                s.exam_code
            FROM grading_results r
            JOIN submissions s ON s.id = r.submission_id
            WHERE s.id = $1
            ORDER BY r.graded_at DESC
            LIMIT 1
            `,
            [req.params.id]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                error: "Chưa có kết quả"
            });
        }

        const data = result.rows[0];

        const workbook = new ExcelJS.Workbook();

        const sheet = workbook.addWorksheet("Ket qua");

        sheet.columns = [
            {
                header: "Câu",
                key: "no",
                width: 12
            },
            {
                header: "Đáp án thí sinh",
                key: "student",
                width: 22
            },
            {
                header: "Đáp án đúng",
                key: "correct",
                width: 22
            },
            {
                header: "Kết quả",
                key: "status",
                width: 15
            },
            {
                header: "Điểm",
                key: "points",
                width: 12
            }
        ];

        const formatAnswerCell = value => {
            if (value === null || value === undefined || value === "") return "";
            return typeof value === "string" ? value : JSON.stringify(value);
        };

        for (const item of data.detail) {
            sheet.addRow({
                no: item.question_no,

                student: formatAnswerCell(item.student_answer),

                correct: formatAnswerCell(item.correct_answer),

                status: item.student_answer === null
                    ? "Bỏ trống"
                    : item.correct
                        ? "Đúng"
                        : "Sai",

                points: item.points
            });
        }

        sheet.addRow({});

        sheet.addRow([
            "Tổng điểm",
            data.total_score,
            "/",
            data.max_score
        ]);

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        res.setHeader(
            "Content-Disposition",
            'attachment; filename="quiz-result.xlsx"'
        );

        await workbook.xlsx.write(res);

        res.end();
    })
);

// ======================================================
// 15b. DANH SÁCH ĐIỂM CẢ KỲ THI + XUẤT EXCEL HÀNG LOẠT
// ======================================================

// Định dạng thời gian theo giờ Việt Nam, chính xác đến từng giây.
// display: "20/11/2026 14:03:07"   file: "20261120-140307"
function vnTime(value) {
    if (!value) return { display: "", file: "" };

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) return { display: "", file: "" };

    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Ho_Chi_Minh",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hourCycle: "h23"
        }).formatToParts(date).map(p => [p.type, p.value])
    );

    return {
        display: `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`,
        file: `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`
    };
}

// Lấy kết quả chấm MỚI NHẤT của từng bài làm trong 1 kỳ thi
// (tùy chọn lọc theo 1 mã đề).
async function fetchExamResults(examId, paperId) {
    const params = [examId];
    let paperFilter = "";

    if (paperId) {
        params.push(paperId);
        paperFilter = "AND p.id = $2";
    }

    const result = await db.query(
        `
        SELECT
            s.id AS submission_id,
            s.code AS submission_code,
            s.student_code,
            COALESCE(s.scanned_at, s.created_at) AS scanned_at,
            p.id AS paper_id,
            p.paper_code,
            st.full_name,
            g.total_score,
            g.max_score,
            g.correct_count,
            g.incorrect_count,
            g.blank_count,
            COALESCE(g.ambiguous_count, 0) AS ambiguous_count,
            g.graded_at,
            g.detail
        FROM submissions s
        JOIN exam_papers p ON p.id = s.paper_id
        JOIN LATERAL (
            SELECT *
            FROM grading_results
            WHERE submission_id = s.id
            ORDER BY graded_at DESC
            LIMIT 1
        ) g ON TRUE
        LEFT JOIN students st ON st.id = s.student_id
        WHERE p.exam_id = $1
        ${paperFilter}
        ORDER BY p.paper_code, s.student_code NULLS LAST, COALESCE(s.scanned_at, s.created_at)
        `,
        params
    );

    return result.rows;
}

app.get(
    "/api/exams/:id/results",
    asyncRoute(async (req, res) => {
        const rows = await fetchExamResults(
            req.params.id,
            req.query.paper_id || null
        );

        res.json(
            rows.map(({ detail, ...rest }) => ({
                ...rest,
                scanned_at_display: vnTime(rest.scanned_at).display
            }))
        );
    })
);

app.get(
    "/api/exams/:id/results/excel",
    asyncRoute(async (req, res) => {
        const rows = await fetchExamResults(
            req.params.id,
            req.query.paper_id || null
        );

        if (!rows.length) {
            return res.status(404).json({
                error: "Kỳ thi này chưa có bài nào được chấm"
            });
        }

        const workbook = new ExcelJS.Workbook();

        const HEADER_FILL = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1D4ED8" }
        };
        const YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEB9C" } };
        const GREEN = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
        const RED = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };

        const styleHeader = sheet => {
            const header = sheet.getRow(1);

            header.font = { bold: true, color: { argb: "FFFFFFFF" } };
            header.fill = HEADER_FILL;
            header.alignment = { vertical: "middle", horizontal: "center" };

            sheet.views = [{ state: "frozen", ySplit: 1 }];
        };

        // ---------- Sheet 1: danh sách điểm ----------
        const hasName = rows.some(r => r.full_name);

        const summary = workbook.addWorksheet("Danh sách điểm");

        summary.columns = [
            { header: "STT", key: "stt", width: 7 },
            { header: "Mã bài", key: "code", width: 10 },
            { header: "SBD", key: "sbd", width: 14 },
            ...(hasName ? [{ header: "Họ và tên", key: "name", width: 28 }] : []),
            { header: "Mã đề", key: "paper", width: 10 },
            { header: "Điểm", key: "score", width: 10 },
            { header: "Thang điểm", key: "max", width: 12 },
            { header: "Điểm (thang 10)", key: "score10", width: 16 },
            { header: "Đúng", key: "correct", width: 9 },
            { header: "Sai", key: "incorrect", width: 9 },
            { header: "Bỏ trống", key: "blank", width: 11 },
            { header: "Chưa rõ", key: "ambiguous", width: 10 },
            { header: "Thời gian chấm", key: "time", width: 21 },
            { header: "Ghi chú", key: "note", width: 34 }
        ];

        styleHeader(summary);

        rows.forEach((r, index) => {
            const score = Number(r.total_score);
            const max = Number(r.max_score);

            const notes = [];

            if (!r.student_code) notes.push("Chưa đọc được SBD");
            if (Number(r.ambiguous_count) > 0) {
                notes.push(`${r.ambiguous_count} câu tô mờ/nhiều ô, cần xem lại`);
            }

            const row = summary.addRow({
                stt: index + 1,
                code: r.submission_code || "",
                sbd: r.student_code || "",
                name: r.full_name || "",
                paper: r.paper_code,
                score,
                max,
                score10: max > 0 ? Number(((score / max) * 10).toFixed(2)) : 0,
                correct: r.correct_count,
                incorrect: r.incorrect_count,
                blank: r.blank_count,
                ambiguous: Number(r.ambiguous_count),
                time: vnTime(r.scanned_at).display,
                note: notes.join("; ")
            });

            // SBD dạng text để không mất số 0 đầu
            row.getCell("sbd").numFmt = "@";

            if (notes.length) {
                row.eachCell(cell => { cell.fill = YELLOW; });
            }
        });

        summary.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: summary.columnCount }
        };

        // ---------- Sheet 2: chi tiết từng câu ----------
        const questionKeys = new Map(); // "TYPE:no" -> {type, no}

        for (const r of rows) {
            for (const item of (r.detail || [])) {
                const key = `${item.question_type}:${item.question_no}`;

                if (!questionKeys.has(key)) {
                    questionKeys.set(key, {
                        type: item.question_type,
                        no: item.question_no
                    });
                }
            }
        }

        const sortedKeys = Array.from(questionKeys.entries()).sort(
            ([, a], [, b]) =>
                a.type === b.type ? a.no - b.no : a.type.localeCompare(b.type)
        );

        const detail = workbook.addWorksheet("Chi tiết từng câu");

        detail.columns = [
            { header: "Mã bài", key: "code", width: 10 },
            { header: "SBD", key: "sbd", width: 14 },
            { header: "Mã đề", key: "paper", width: 10 },
            ...sortedKeys.map(([key, q]) => ({
                header: q.type === "TRUE_FALSE" ? `Câu ${q.no} (Đ/S)` : `Câu ${q.no}`,
                key,
                width: q.type === "TRUE_FALSE" ? 16 : 9
            }))
        ];

        styleHeader(detail);

        const cellText = value => {
            if (value === null || value === undefined || value === "") return "";
            return typeof value === "string" ? value : JSON.stringify(value);
        };

        for (const r of rows) {
            const values = { code: r.submission_code || "", sbd: r.student_code || "", paper: r.paper_code };
            const fills = {};

            for (const item of (r.detail || [])) {
                const key = `${item.question_type}:${item.question_no}`;

                values[key] = cellText(item.student_answer);

                if (item.mark_status === "correct") fills[key] = GREEN;
                else if (item.mark_status === "incorrect") fills[key] = RED;
                else if (item.mark_status === "multiple" || item.mark_status === "faint") {
                    fills[key] = YELLOW;
                }
            }

            const row = detail.addRow(values);

            row.getCell("sbd").numFmt = "@";

            for (const [key, fill] of Object.entries(fills)) {
                row.getCell(key).fill = fill;
            }
        }

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        res.setHeader(
            "Content-Disposition",
            'attachment; filename="danh-sach-diem.xlsx"'
        );

        await workbook.xlsx.write(res);

        res.end();
    })
);

// ======================================================
// 16. OMR - HIỆU CHỈNH TEMPLATE (XEM TRƯỚC)
// ======================================================
//
// Dùng để kiểm tra tọa độ các ô tròn trong backend/omr/template.js có khớp
// với phiếu in thực tế hay không. Gửi 1 ảnh chụp phiếu TRẮNG (chưa tô),
// hệ thống sẽ trả về ảnh đã "duỗi thẳng" kèm các chấm xanh tại vị trí mà
// hệ thống nghĩ là tâm từng ô tròn. Nếu chấm xanh lệch khỏi tâm ô tròn in
// trên phiếu, chỉnh lại các số trong template.js rồi thử lại.

function buildWarpHomography(detectedMarkers) {
    const src = [
        omrTemplate.markers.top_left,
        omrTemplate.markers.top_right,
        omrTemplate.markers.bottom_left,
        omrTemplate.markers.bottom_right
    ];

    const dst = [
        detectedMarkers.top_left,
        detectedMarkers.top_right,
        detectedMarkers.bottom_left,
        detectedMarkers.bottom_right
    ];

    return computeHomography(src, dst);
}

app.post(
    "/api/omr/calibration-preview",
    upload.single("file"),
    asyncRoute(async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                error: "Chưa tải ảnh phiếu mẫu"
            });
        }

        const detection = await detectMarkers(req.file.path);

        if (!detection.markers) {
            return res.status(422).json({
                error: "Không nhận diện đủ 4 ô vuông đen ở góc phiếu",
                missing: detection.missing
            });
        }

        const H = buildWarpHomography(detection.markers);

        const original = await Jimp.read(req.file.path);

        const warped = await warpToReference(
            Jimp,
            original,
            H,
            omrTemplate.REF_W,
            omrTemplate.REF_H
        );

        const BLUE = Jimp.rgbaToInt(37, 99, 235, 255);
        const dotRadius = 3;

        const drawDot = (x, y) => {
            for (let dy = -dotRadius; dy <= dotRadius; dy++) {
                for (let dx = -dotRadius; dx <= dotRadius; dx++) {
                    if (dx * dx + dy * dy > dotRadius * dotRadius) continue;

                    const px = Math.round(x + dx);
                    const py = Math.round(y + dy);

                    if (
                        px >= 0 && py >= 0 &&
                        px < warped.bitmap.width &&
                        py < warped.bitmap.height
                    ) {
                        warped.setPixelColor(BLUE, px, py);
                    }
                }
            }
        };

        omrTemplate.sbdColumns.forEach(
            column => column.forEach(cell => drawDot(cell.x, cell.y))
        );

        omrTemplate.maDeColumns.forEach(
            column => column.forEach(cell => drawDot(cell.x, cell.y))
        );

        omrTemplate.questionBubbles.forEach(
            bubbles => bubbles.forEach(b => drawDot(b.x, b.y))
        );

        const buffer = await warped.getBufferAsync(Jimp.MIME_PNG);

        res.json({
            message: "Kiểm tra các chấm xanh có rơi đúng tâm từng ô tròn không",
            preview: `data:image/png;base64,${buffer.toString("base64")}`,
            markersUsed: detection.markers,
            thresholdUsed: detection.thresholdUsed
        });
    })
);

// ======================================================
// 17. OMR - QUÉT PHIẾU BẰNG CAMERA VÀ CHẤM ĐIỂM NGAY
// ======================================================

app.post(
    "/api/submissions/scan",
    upload.single("file"),
    asyncRoute(async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                error: "Chưa tải ảnh phiếu trả lời"
            });
        }

        const {
            exam_id,
            paper_id: manualPaperId,
            student_code: manualStudentCode
        } = req.body;

        if (!manualPaperId && !exam_id) {
            return res.status(400).json({
                error: "Thiếu exam_id (để tự nhận diện Mã đề) hoặc paper_id (nếu đã chọn mã đề thủ công)"
            });
        }

        const detection = await detectMarkers(req.file.path);

        if (!detection.markers) {
            return res.status(422).json({
                error:
                    "Không nhận diện được phiếu. Hãy chụp lại: nhìn rõ cả 4 ô " +
                    "vuông đen ở góc phiếu, đủ ánh sáng, phiếu không bị che hoặc gấp nếp.",
                missing: detection.missing
            });
        }

        const original = await Jimp.read(req.file.path);

        // Thử cả 4 hướng xoay và kiểm tra các ô đen đối chứng để chắc chắn
        // phiếu đã được nắn đúng trước khi đọc đáp án.
        const orientation = chooseOrientation(original, detection.markers);

        if (!orientation || orientation.passed < MIN_PASSED) {
            return res.status(422).json({
                error:
                    "Ảnh chưa đủ chuẩn để đọc chính xác (phiếu bị nghiêng quá nhiều, " +
                    "mờ, chụp quá xa, bị che hoặc gấp nếp). Hãy chụp lại: để phiếu " +
                    "phẳng, thấy rõ toàn bộ phiếu và đủ sáng.",
                alignment: orientation
                    ? { passed: orientation.passed, total: orientation.total }
                    : null
            });
        }

        const H = orientation.H;

        const warped = await warpToReference(
            Jimp,
            original,
            H,
            omrTemplate.REF_W,
            omrTemplate.REF_H
        );

        const sbd = readSBD(warped);
        const maDe = readMaDe(warped);

        let paperId = manualPaperId || null;
        let paper = null;

        if (paperId) {
            const paperResult = await db.query(
                "SELECT * FROM exam_papers WHERE id = $1",
                [paperId]
            );

            if (!paperResult.rowCount) {
                return res.status(404).json({
                    error: "Không tìm thấy mã đề đã chọn"
                });
            }

            paper = paperResult.rows[0];

        } else {
            if (maDe.status !== "filled") {
                return res.status(422).json({
                    error:
                        "Không đọc rõ ô Mã đề trên phiếu (tô mờ, tô nhiều ô, " +
                        "hoặc bỏ trống). Hãy chụp lại hoặc chọn mã đề thủ công.",
                    detected_paper_code: maDe.value,
                    paper_code_status: maDe.status
                });
            }

            const paperResult = await db.query(
                "SELECT * FROM exam_papers WHERE exam_id = $1 AND paper_code = $2",
                [exam_id, maDe.value]
            );

            if (!paperResult.rowCount) {
                return res.status(404).json({
                    error:
                        `Đọc được Mã đề "${maDe.value}" nhưng không khớp mã ` +
                        "đề nào trong kỳ thi này. Kiểm tra lại hoặc chọn mã đề thủ công.",
                    detected_paper_code: maDe.value
                });
            }

            paper = paperResult.rows[0];
            paperId = paper.id;
        }

        const questions = await db.query(
            `
            SELECT
                q.id,
                q.question_no,
                q.question_type,
                a.correct_answer,
                a.points
            FROM questions q
            JOIN answer_keys a ON a.question_id = q.id
            WHERE q.paper_id = $1
            ORDER BY q.question_no
            `,
            [paperId]
        );

        if (!questions.rowCount) {
            return res.status(400).json({
                error: "Mã đề này chưa có câu hỏi/đáp án nào"
            });
        }

        // Chỉ đọc đúng các câu thực sự có trong đề (vd đề 30 câu / phiếu in
        // sẵn 40 câu -> các câu 31-40 trên phiếu sẽ không được đọc/chấm).
        const readDetails = readQuestions(warped, questions.rows);

        const answers = {};
        const markStatus = {};

        readDetails.forEach(detail => {
            answers[detail.question_id] = detail.choice;
            markStatus[detail.question_id] = detail.status;
        });

        const result = gradeExam(questions.rows, answers, markStatus);

        const readByQuestionId = new Map(
            readDetails.map(d => [d.question_id, d])
        );

        const detailsForAnnotation = result.details.map(detail => {
            const read = readByQuestionId.get(detail.question_id);

            return {
                ...detail,
                choice: read ? read.choice : null,
                bubbles: read ? read.bubbles : [],
                scores: read ? read.scores : []
            };
        });

        const annotated = annotateImage(Jimp, warped, detailsForAnnotation);

        // Thời điểm chấm (một nguồn duy nhất cho DB, tên file và Excel)
        const scannedAt = new Date();
        const stamp = vnTime(scannedAt);

        const finalStudentCode =
            (manualStudentCode && manualStudentCode.trim()) ||
            (sbd.status === "filled" ? sbd.value : null);

        const relativeUploadPath = path.relative(
            path.resolve("."),
            req.file.path
        ).replace(/\\/g, "/");

        const safe = value => String(value || "").replace(/[^A-Za-z0-9_-]/g, "");

        const annotatedFileName =
            `${stamp.file}_` +
            (safe(finalStudentCode || String(sbd.value).replace(/\?/g, "x")) || "nosbd") +
            `_${safe(paper.paper_code) || "made"}.jpg`;

        const annotatedFullPath = path.join(annotatedDir, annotatedFileName);

        // Ảnh đã chấm (có vòng màu) và ảnh gốc: nén JPEG để lưu thẳng vào DB
        const annotatedBuffer = await annotated
            .clone()
            .quality(88)
            .getBufferAsync(Jimp.MIME_JPEG);

        const originalBuffer = await original
            .clone()
            .scaleToFit(1600, 1600)
            .quality(80)
            .getBufferAsync(Jimp.MIME_JPEG);

        // Bản sao trên đĩa (phòng khi cần), nhưng nguồn chính là database
        await fs.promises.writeFile(annotatedFullPath, annotatedBuffer);

        const relativeAnnotatedPath = path.relative(
            path.resolve("."),
            annotatedFullPath
        ).replace(/\\/g, "/");

        const client = await db.pool.connect();

        let submissionId;
        let submissionCode;

        try {
            await client.query("BEGIN");

            const submissionInsert = await client.query(
                `
                INSERT INTO submissions(
                    paper_id, student_code, exam_code, image_path,
                    detected_student_code, detected_paper_code,
                    annotated_image_path, status, source,
                    scanned_at, image_data, annotated_image_data
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,'graded','scan',$8,$9,$10)
                RETURNING id, code
                `,
                [
                    paperId,
                    finalStudentCode,
                    maDe.value,
                    relativeUploadPath,
                    sbd.value,
                    maDe.value,
                    relativeAnnotatedPath,
                    scannedAt,
                    originalBuffer,
                    annotatedBuffer
                ]
            );

            submissionId = submissionInsert.rows[0].id;
            submissionCode = submissionInsert.rows[0].code;

            for (const detail of result.details) {
                await client.query(
                    `
                    INSERT INTO detected_answers(
                        submission_id, question_id, student_answer,
                        confidence, verified, mark_status
                    )
                    VALUES ($1,$2,$3,$4,FALSE,$5)
                    ON CONFLICT(submission_id, question_id)
                    DO UPDATE SET
                        student_answer = EXCLUDED.student_answer,
                        mark_status = EXCLUDED.mark_status
                    `,
                    [
                        submissionId,
                        detail.question_id,
                        JSON.stringify(detail.student_answer),
                        null,
                        detail.mark_status
                    ]
                );
            }

            await client.query(
                `
                INSERT INTO grading_results(
                    submission_id, total_questions, correct_count,
                    incorrect_count, blank_count, ambiguous_count,
                    total_score, max_score, detail
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                `,
                [
                    submissionId,
                    result.total_questions,
                    result.correct_count,
                    result.incorrect_count,
                    result.blank_count,
                    result.ambiguous_count,
                    result.total_score,
                    result.max_score,
                    JSON.stringify(result.details)
                ]
            );

            await client.query("COMMIT");

        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;

        } finally {
            client.release();
        }

        // Cảnh báo nếu SBD này đã được chấm trước đó trong cùng kỳ thi
        let duplicateCount = 0;

        if (finalStudentCode) {
            const dup = await db.query(
                `
                SELECT COUNT(*)::int AS n
                FROM submissions s
                JOIN exam_papers p ON p.id = s.paper_id
                WHERE p.exam_id = (SELECT exam_id FROM exam_papers WHERE id = $1)
                  AND s.student_code = $2
                  AND s.id <> $3
                `,
                [paperId, finalStudentCode, submissionId]
            );

            duplicateCount = dup.rows[0].n;
        }

        res.status(201).json({
            message: "Đã quét và chấm điểm tự động",
            submission_id: submissionId,
            submission_code: submissionCode,
            student_code: finalStudentCode,
            scanned_at: scannedAt.toISOString(),
            scanned_at_display: stamp.display,
            duplicate_count: duplicateCount,
            paper: {
                id: paper.id,
                paper_code: paper.paper_code,
                title: paper.title
            },
            detected: {
                student_code: sbd.value,
                student_code_status: sbd.status,
                paper_code: maDe.value,
                paper_code_status: maDe.status
            },
            grading: result,
            annotated_image_url: `/api/submissions/${submissionId}/annotated-image`
        });
    })
);

// ======================================================
// 18. OMR - ẢNH BÀI THI ĐÃ CHẤM (CÓ VÒNG TRÒN MÀU)
// ======================================================

app.get(
    "/api/submissions/:id/annotated-image",
    asyncRoute(async (req, res) => {
        const result = await db.query(
            `
            SELECT annotated_image_data, annotated_image_path,
                   student_code, scanned_at
            FROM submissions WHERE id = $1
            `,
            [req.params.id]
        );

        const row = result.rows[0];

        if (!row || (!row.annotated_image_data && !row.annotated_image_path)) {
            return res.status(404).json({
                error: "Chưa có ảnh đã chấm cho bài làm này"
            });
        }

        // Ưu tiên ảnh lưu trong database (không mất khi server khởi động lại)
        if (row.annotated_image_data) {
            const name = `${vnTime(row.scanned_at).file}_${row.student_code || "nosbd"}.jpg`
                .replace(/[^A-Za-z0-9._-]/g, "");

            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Content-Disposition", `inline; filename="${name}"`);
            res.setHeader("Cache-Control", "private, max-age=3600");

            return res.send(row.annotated_image_data);
        }

        res.sendFile(path.resolve(row.annotated_image_path));
    })
);

app.get(
    "/api/submissions/:id/image",
    asyncRoute(async (req, res) => {
        const result = await db.query(
            "SELECT image_data, image_path FROM submissions WHERE id = $1",
            [req.params.id]
        );

        const row = result.rows[0];

        if (!row || (!row.image_data && !row.image_path)) {
            return res.status(404).json({ error: "Không có ảnh gốc" });
        }

        if (row.image_data) {
            res.setHeader("Content-Type", "image/jpeg");
            res.setHeader("Cache-Control", "private, max-age=3600");

            return res.send(row.image_data);
        }

        res.sendFile(path.resolve(row.image_path));
    })
);

// Sửa SBD ngay sau khi quét (khi hệ thống đọc sai / không đọc được)
app.patch(
    "/api/submissions/:id/student-code",
    asyncRoute(async (req, res) => {
        const code = String((req.body || {}).student_code ?? "").trim();

        if (code.length > 50) {
            return res.status(400).json({ error: "Số báo danh quá dài" });
        }

        const result = await db.query(
            `
            UPDATE submissions
            SET student_code = $1
            WHERE id = $2
            RETURNING id, student_code
            `,
            [code || null, req.params.id]
        );

        if (!result.rowCount) {
            return res.status(404).json({ error: "Không tìm thấy bài làm" });
        }

        res.json(result.rows[0]);
    })
);

// ======================================================
// 19. PHỤC VỤ FRONTEND
// ======================================================

app.use(
    express.static(
        path.join(__dirname, "../frontend")
    )
);

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "../frontend/index.html")
    );
});

// ======================================================
// 20. XỬ LÝ LỖI
// ======================================================

app.use((err, req, res, next) => {
    console.error(err);

    res.status(500).json({
        error: "Server error",
        detail: err.message
    });
});

// ======================================================
// 21. KHỞI ĐỘNG SERVER
// ======================================================

const PORT = process.env.PORT || 3000;

// Tự áp dụng migration OMR (an toàn khi chạy lại nhiều lần)
async function ensureOmrMigration() {
    await db.query(`
        ALTER TABLE submissions
            ADD COLUMN IF NOT EXISTS detected_student_code VARCHAR(50),
            ADD COLUMN IF NOT EXISTS detected_paper_code VARCHAR(50),
            ADD COLUMN IF NOT EXISTS annotated_image_path TEXT,
            ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'manual'
    `);
    await db.query(`
        ALTER TABLE submissions
            ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS image_data BYTEA,
            ADD COLUMN IF NOT EXISTS annotated_image_data BYTEA
    `);
    // Mã 8 ký tự, ngẫu nhiên, dễ nhớ (2 chữ cái + 6 chữ số):
    //   kỳ thi  : KT + 6 số   (vd KT483921)
    //   bài làm : BL + 6 số   (vd BL274058)
    // Mã được chọn ngẫu nhiên và kiểm tra trùng, KHÔNG phụ thuộc bộ đếm,
    // nên xóa kỳ thi rồi tạo mới sẽ không còn "nhớ" số cũ.
    await db.query("ALTER TABLE exams ADD COLUMN IF NOT EXISTS code VARCHAR(12)");
    await db.query("ALTER TABLE submissions ADD COLUMN IF NOT EXISTS code VARCHAR(12)");

    await db.query(`
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
        $$ LANGUAGE plpgsql
    `);

    await db.query(`
        CREATE OR REPLACE FUNCTION set_exam_code() RETURNS trigger AS $$
        BEGIN
            IF NEW.code IS NULL THEN
                NEW.code := random_unique_code('KT', 'exams');
            END IF;
            RETURN NEW;
        END
        $$ LANGUAGE plpgsql
    `);
    await db.query(`
        CREATE OR REPLACE FUNCTION set_submission_code() RETURNS trigger AS $$
        BEGIN
            IF NEW.code IS NULL THEN
                NEW.code := random_unique_code('BL', 'submissions');
            END IF;
            RETURN NEW;
        END
        $$ LANGUAGE plpgsql
    `);

    // bỏ cách đánh số tăng dần cũ, dùng trigger tạo mã ngẫu nhiên
    await db.query("ALTER TABLE exams ALTER COLUMN code DROP DEFAULT");
    await db.query("ALTER TABLE submissions ALTER COLUMN code DROP DEFAULT");

    await db.query("DROP TRIGGER IF EXISTS trg_exam_code ON exams");
    await db.query(`
        CREATE TRIGGER trg_exam_code BEFORE INSERT ON exams
        FOR EACH ROW EXECUTE PROCEDURE set_exam_code()
    `);
    await db.query("DROP TRIGGER IF EXISTS trg_submission_code ON submissions");
    await db.query(`
        CREATE TRIGGER trg_submission_code BEFORE INSERT ON submissions
        FOR EACH ROW EXECUTE PROCEDURE set_submission_code()
    `);

    // Đổi mã cũ (dạng KT001 / B00001) sang định dạng mới 8 ký tự
    const { randomInt } = require("crypto");

    async function recode(table, prefix) {
        const rows = await db.query(
            `SELECT id FROM ${table} WHERE code IS NULL OR code !~ $1`,
            [`^${prefix}[0-9]{6}$`]
        );

        for (const row of rows.rows) {
            for (let attempt = 0; attempt < 30; attempt++) {
                const code = prefix + randomInt(100000, 1000000);

                try {
                    await db.query(
                        `UPDATE ${table} SET code = $1 WHERE id = $2`,
                        [code, row.id]
                    );
                    break;
                } catch (error) {
                    if (error.code !== "23505") throw error; // chỉ thử lại khi trùng mã
                }
            }
        }
    }

    await db.query("DROP INDEX IF EXISTS ux_exams_code");
    await db.query("DROP INDEX IF EXISTS ux_submissions_code");

    await recode("exams", "KT");
    await recode("submissions", "BL");

    await db.query("CREATE UNIQUE INDEX IF NOT EXISTS ux_exams_code ON exams(code)");
    await db.query("CREATE UNIQUE INDEX IF NOT EXISTS ux_submissions_code ON submissions(code)");

    // Hạn tự động xóa kỳ thi (mặc định 7 ngày). Kỳ thi đã có sẵn được cấp
    // đủ 7 ngày kể từ lúc migration chạy, KHÔNG bị xóa ngay.
    await db.query(`
        ALTER TABLE exams
            ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    `);
    await db.query(`
        ALTER TABLE exams
            ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '7 days')
    `);
    await db.query(`
        UPDATE exams
        SET expires_at = NOW() + INTERVAL '7 days'
        WHERE expires_at IS NULL
    `);
    await db.query(`
        ALTER TABLE detected_answers
            ADD COLUMN IF NOT EXISTS mark_status VARCHAR(20)
    `);
    await db.query(`
        ALTER TABLE grading_results
            ADD COLUMN IF NOT EXISTS ambiguous_count INTEGER DEFAULT 0
    `);
}

db.testConnection()
    .then(ensureOmrMigration)
    .then(() => {
        app.listen(PORT, "0.0.0.0", () => {
            console.log(
                `QuizGrader running on port ${PORT}`
            );
        });

        // Tự động xóa kỳ thi hết hạn: chạy ngay khi khởi động, rồi mỗi 30 phút
        const runPurge = () =>
            purgeExpiredExams().catch(err =>
                console.error("Lỗi tự động xóa kỳ thi:", err.message)
            );

        runPurge();
        setInterval(runPurge, 30 * 60 * 1000);
    })
    .catch(err => {
        console.error(
            "Database connection failed:",
            err.message
        );

        process.exit(1);
    });