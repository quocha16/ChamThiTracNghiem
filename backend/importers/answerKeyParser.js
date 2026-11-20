/**
 * Đọc đáp án từ bảng dạng
 *
 *   Câu     1   2   3   4   5   6   7
 *   Đáp án  A   B   C   D   A   B   C
 *   Câu     8   9   10  11  12  13  14
 *   Đáp án  A   B   C   D   Đ   S   Đúng
 *
 * (hàng "Câu" chứa số thứ tự câu hỏi, hàng "Đáp án" ngay bên dưới chứa
 * đáp án tương ứng theo đúng cột) — lấy từ Excel (.xlsx đọc được cấu trúc
 * bảng thật), Word (.docx, đọc bảng qua HTML do mammoth xuất ra), hoặc nếu
 * không tìm thấy bảng thì rơi về chế độ quét văn bản thường (PDF luôn dùng
 * chế độ này vì không giữ được cấu trúc bảng khi trích xuất chữ).
 *
 * Mỗi ô đáp án được PHÂN LOẠI tự động:
 *   - 1 chữ cái A/B/C/D (không phân biệt hoa/thường)  -> Phần I (MCQ)
 *   - "Đúng"/"Dung"/"Đ"/"True"/"T", "Sai"/"S"/"False"/"F" -> Phần II (Đúng/Sai)
 *
 * QUAN TRỌNG: chữ "D" một mình LUÔN được hiểu là đáp án D của trắc nghiệm
 * (Phần I), KHÔNG BAO GIỜ được hiểu là viết tắt của "Đúng" — để tránh đọc
 * nhầm, chỉ chữ "Đ" (có dấu) hoặc từ đầy đủ "Đúng"/"Dung" mới được tính là
 * Đúng/Sai. Mọi kết quả đọc được vẫn phải qua bước xem lại thủ công trước
 * khi lưu, không tự ghi thẳng vào CSDL.
 */

const TRUE_TOKENS = new Set(["đúng", "dung", "đ", "true", "t"]);
const FALSE_TOKENS = new Set(["sai", "s", "false", "f"]);

/**
 * Phân loại 1 giá trị ô đáp án. Trả về { question_type, answer } hoặc null
 * nếu không nhận dạng được.
 */
function classifyAnswerValue(raw) {
    const trimmed = String(raw ?? "").trim();

    if (!trimmed) return null;

    // Chỉ 1 ký tự A-D (không phân biệt hoa/thường) -> luôn là Phần I.
    if (/^[A-Da-d]$/.test(trimmed)) {
        return { question_type: "MCQ", answer: trimmed.toUpperCase() };
    }

    const lower = trimmed.toLowerCase();

    if (TRUE_TOKENS.has(lower)) {
        return { question_type: "TRUE_FALSE", answer: "Đúng" };
    }

    if (FALSE_TOKENS.has(lower)) {
        return { question_type: "TRUE_FALSE", answer: "Sai" };
    }

    return null;
}

function normalizeLabel(value) {
    return String(value ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // bỏ dấu
        .replace(/đ/gi, "d")
        .trim()
        .toLowerCase();
}

function isQuestionLabel(value) {
    const n = normalizeLabel(value);
    return n === "cau" || n === "cau so" || n === "stt";
}

function isAnswerLabel(value) {
    const n = normalizeLabel(value);
    return n.startsWith("dap an") || n === "da" || n === "answer" || n === "key";
}

/**
 * @param {Array<Array<string>>} rows mảng các hàng, mỗi hàng là mảng ô (string)
 * @returns {{ answers: Array<{question_no:number, question_type:string, answer:string}>, warnings: string[] }}
 */
function parseRowsForAnswerKey(rows) {
    const answersMap = new Map(); // key: `${type}:${no}` -> {question_no, question_type, answer}
    const warnings = [];
    let blocksFound = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        if (!row || row.length === 0) continue;
        if (!isQuestionLabel(row[0])) continue;

        const nextRow = rows[i + 1];

        if (!nextRow || !isAnswerLabel(nextRow[0])) {
            warnings.push(
                `Tìm thấy hàng "Câu" ở dòng ${i + 1} nhưng dòng ngay dưới không phải "Đáp án", bỏ qua khối này`
            );
            continue;
        }

        blocksFound++;

        const questionCells = row.slice(1);
        const answerCells = nextRow.slice(1);

        if (questionCells.length !== answerCells.length) {
            warnings.push(
                `Khối ở dòng ${i + 1}: số cột "Câu" (${questionCells.length}) khác số cột "Đáp án" (${answerCells.length}), chỉ ghép theo số cột ít hơn`
            );
        }

        const count = Math.min(questionCells.length, answerCells.length);

        for (let c = 0; c < count; c++) {
            const rawNo = String(questionCells[c] ?? "").trim();
            const rawAnswer = String(answerCells[c] ?? "").trim();

            if (!rawNo) continue;

            const no = Number(rawNo);

            if (!Number.isInteger(no) || no < 1) {
                warnings.push(`Ô "Câu" = "${rawNo}" ở dòng ${i + 1} không phải số câu hợp lệ, bỏ qua`);
                continue;
            }

            if (!rawAnswer) {
                warnings.push(`Câu ${no}: ô đáp án trống trong tài liệu`);
                continue;
            }

            const classified = classifyAnswerValue(rawAnswer);

            if (!classified) {
                warnings.push(
                    `Câu ${no}: giá trị đọc được là "${rawAnswer}", không nhận dạng được ` +
                    `(chỉ nhận A/B/C/D cho Phần I, hoặc Đúng/Sai/Đ/S cho Phần II) — cần sửa tay`
                );
                continue;
            }

            const key = `${classified.question_type}:${no}`;

            if (answersMap.has(key)) {
                warnings.push(`Câu ${no} (${classified.question_type}) xuất hiện nhiều lần, lấy giá trị xuất hiện sau cùng`);
            }

            answersMap.set(key, {
                question_no: no,
                question_type: classified.question_type,
                answer: classified.answer
            });
        }
    }

    if (blocksFound === 0) {
        warnings.push('Không tìm thấy bảng dạng "Câu / Đáp án" nào trong tài liệu');
    }

    return finalizeResult(answersMap, warnings);
}

/**
 * Chế độ dự phòng: quét trong văn bản phẳng (không còn cấu trúc bảng) tìm
 * các cặp "số câu + 1 ký tự", ví dụ "1A 2B 3C", "1. A", "Câu 5: B", "12 Đ".
 *
 * Chỉ nhận ký tự ĐƠN (A-D, Đ, S) ở chế độ này — KHÔNG nhận các từ đầy đủ
 * như "Đúng"/"Sai"/"True"/"False", vì văn bản trích từ PDF thường lẫn rất
 * nhiều chữ khác (đề bài, hướng dẫn...) nên so khớp từ dài dễ bắt nhầm.
 * Dùng khi không trích xuất được bảng (PDF, hoặc Word/Excel không có bảng).
 */
function parseFlatTextForAnswerKey(text) {
    const answersMap = new Map();
    const warnings = [];

    // Không dùng \b ở cuối vì \b dựa trên \w, mà \w không coi "Đ"/"đ" là ký
    // tự chữ cái -> \b sẽ không khớp đúng sau "Đ". Dùng lookahead tường minh
    // (khoảng trắng / dấu câu / hết chuỗi) để vẫn tránh bắt nhầm 1 chữ cái
    // đầu của một từ dài hơn (vd "Doanh" không bị đọc nhầm thành "D").
    const regex = /\b(\d{1,3})\s*[.\-:)]?\s*([A-Da-dĐđSsTtFf])(?=[\s,;.]|$)/g;

    let match;
    let found = 0;

    while ((match = regex.exec(text || "")) !== null) {
        const no = Number(match[1]);
        const classified = classifyAnswerValue(match[2]);

        if (!classified) continue; // không thể xảy ra với bộ ký tự trên, nhưng cho chắc

        found++;

        const key = `${classified.question_type}:${no}`;

        if (answersMap.has(key) && answersMap.get(key).answer !== classified.answer) {
            warnings.push(`Câu ${no} (${classified.question_type}) xuất hiện với 2 đáp án khác nhau trong văn bản, lấy giá trị xuất hiện sau cùng`);
        }

        answersMap.set(key, {
            question_no: no,
            question_type: classified.question_type,
            answer: classified.answer
        });
    }

    if (found === 0) {
        warnings.push("Không nhận dạng được câu nào trong văn bản trích xuất — định dạng tài liệu có thể không được hỗ trợ, cần nhập tay");
    } else {
        warnings.push("Đã đọc theo chế độ quét văn bản thường (không có cấu trúc bảng rõ ràng) — độ chính xác thấp hơn, cần kiểm tra kỹ từng câu");
    }

    return finalizeResult(answersMap, warnings);
}

function finalizeResult(answersMap, warnings) {
    const answers = Array.from(answersMap.values())
        .sort((a, b) =>
            a.question_type === b.question_type
                ? a.question_no - b.question_no
                : a.question_type.localeCompare(b.question_type)
        );

    return { answers, warnings };
}

/**
 * Trích bảng từ HTML do mammoth xuất ra (mỗi <tr> là 1 hàng, mỗi <td>/<th>
 * là 1 ô). Dùng regex đơn giản vì không có sẵn thư viện phân tích HTML.
 */
function extractTableRowsFromHtml(html) {
    const rows = [];
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

    let trMatch;

    while ((trMatch = trRegex.exec(html || "")) !== null) {
        const rowHtml = trMatch[1];
        const cells = [];

        let cellMatch;
        const localCellRegex = new RegExp(cellRegex.source, "gi");

        while ((cellMatch = localCellRegex.exec(rowHtml)) !== null) {
            const text = cellMatch[1]
                .replace(/<[^>]+>/g, " ") // bỏ thẻ con (vd <p>, <strong>)
                .replace(/&nbsp;/gi, " ")
                .replace(/&amp;/gi, "&")
                .replace(/\s+/g, " ")
                .trim();

            cells.push(text);
        }

        if (cells.length > 0) rows.push(cells);
    }

    return rows;
}

module.exports = {
    parseRowsForAnswerKey,
    parseFlatTextForAnswerKey,
    extractTableRowsFromHtml,
    classifyAnswerValue,
    normalizeLabel
};
