const API = "/api";

let currentSubmission = null;
let currentResult = null;
let questions = [];

async function request(url, options = {}) {
    const response = await fetch(API + url, options);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || data.message || "Có lỗi xảy ra");
    }

    return data;
}

// Chuẩn hoá đáp án Phần II (Đúng/Sai) nhập tay — người dùng đã chọn rõ
// loại câu hỏi là TRUE_FALSE nên không có nguy cơ nhầm với MCQ, nên ở đây
// chấp nhận cả kiểu gõ tắt (Đ, D, S, T, F...).
function normalizeTrueFalseAnswer(raw) {
    const v = String(raw ?? "").trim().toLowerCase();

    if (["đúng", "dung", "đ", "d", "true", "t"].includes(v)) return "Đúng";
    if (["sai", "s", "false", "f"].includes(v)) return "Sai";

    return null;
}

function toast(message) {
    const element = document.getElementById("toast");

    element.textContent = message;
    element.style.display = "block";

    setTimeout(() => {
        element.style.display = "none";
    }, 3000);
}

function showPage(page) {
    document.querySelectorAll(".page").forEach(item => {
        item.classList.remove("active");
    });

    document.querySelectorAll(".nav").forEach(item => {
        item.classList.remove("active");
    });

    document.getElementById(page).classList.add("active");

    document.querySelector(
        `.nav[data-page="${page}"]`
    )?.classList.add("active");

    if (page === "dashboard") loadDashboard();
    if (page === "exams") loadExams();
    if (page === "answers") loadExamOptions();
    if (page === "grading") {
        loadPaperOptions();
        loadScanExamOptions();
    }
    if (page === "results") loadResultExamOptions();
}

document.querySelectorAll(".nav").forEach(button => {
    button.addEventListener("click", () => {
        showPage(button.dataset.page);
    });
});

// DASHBOARD
async function loadDashboard() {
    try {
        const exams = await request("/exams");

        document.getElementById("examCount").textContent =
            exams.length;

        let submissions = 0;
        let graded = 0;

        for (const exam of exams) {
            const papers = await request(`/exams/${exam.id}/papers`);

            for (const paper of papers) {
                const result = await request(
                    `/papers/${paper.id}/submissions`
                ).catch(() => []);

                submissions += result.length;
                graded += result.filter(
                    x => x.status === "graded"
                ).length;
            }
        }

        document.getElementById("submissionCount").textContent =
            submissions;

        document.getElementById("gradedCount").textContent =
            graded;

    } catch (error) {
        console.error(error);
    }
}

// EXAMS
function formatBytes(bytes) {
    const n = Number(bytes) || 0;

    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;

    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRemaining(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;

    if (days > 0) return `${days} ngày ${hours} giờ ${minutes} phút`;

    const pad = n => String(n).padStart(2, "0");

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatExpiry(expiresAt) {
    if (!expiresAt) return { text: "Không giới hạn", urgent: false };

    const end = new Date(expiresAt);
    const ms = end.getTime() - Date.now();

    const endText = end.toLocaleString("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        hour12: false
    });

    if (ms <= 0) {
        return { text: `Đã hết hạn (${endText}), sắp bị xóa`, urgent: true };
    }

    return {
        text: `Tự động xóa sau ${formatRemaining(ms)} (lúc ${endText})`,
        urgent: ms < 24 * 3600000
    };
}

// Nhãn ngắn gắn vào tên kỳ thi trong các ô chọn: " (còn 6 ngày)"
function remainingLabel(expiresAt) {
    if (!expiresAt) return "";

    const ms = new Date(expiresAt).getTime() - Date.now();

    if (ms <= 0) return " (đã hết hạn)";

    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);

    return days > 0
        ? ` (còn ${days} ngày ${hours} giờ)`
        : ` (còn ${hours} giờ — cần gia hạn)`;
}

// ---------- Cảnh báo + đếm ngược trực tiếp ----------
let knownExams = [];
const EXPIRY_WARN_MS = 48 * 3600000;

function setKnownExams(exams) {
    knownExams = exams;
    updateExpiryUI();
}

function updateExpiryUI() {
    // đếm ngược từng kỳ thi trong danh sách
    document.querySelectorAll(".countdown[data-expires]").forEach(el => {
        const expiry = formatExpiry(el.dataset.expires);

        el.textContent = expiry.text;
        el.style.color = expiry.urgent ? "var(--danger)" : "var(--text-secondary)";
    });

    // banner cảnh báo các kỳ thi còn dưới 48 giờ
    const banner = document.getElementById("expiryBanner");

    const soon = knownExams.filter(exam =>
        exam.expires_at &&
        new Date(exam.expires_at).getTime() - Date.now() < EXPIRY_WARN_MS
    );

    if (!soon.length) {
        banner.hidden = true;
        banner.innerHTML = "";

        return;
    }

    banner.hidden = false;

    banner.innerHTML =
        "<div>⚠ Kỳ thi sắp bị tự động xóa — cần gia hạn nếu muốn giữ lại:</div>" +
        soon.map(exam => `
            <div class="expiry-row">
                <span>
                    ${escapeHTML(exam.name)} —
                    ${escapeHTML(formatExpiry(exam.expires_at).text)}
                </span>
                <button type="button" class="extend-exam-banner"
                    data-id="${escapeHTML(exam.id)}">
                    Gia hạn thêm 7 ngày
                </button>
            </div>
        `).join("");
}

async function refreshExpiryData() {
    try {
        setKnownExams(await request("/exams?light=1"));
    } catch (error) {
        /* lỗi mạng thoáng qua: bỏ qua, lần sau thử lại */
    }
}

document.getElementById("expiryBanner").addEventListener(
    "click",
    async event => {
        const button = event.target.closest(".extend-exam-banner");

        if (!button) return;

        button.disabled = true;

        try {
            await request(`/exams/${button.dataset.id}/extend`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ days: 7 })
            });

            toast("Đã gia hạn thêm 7 ngày");

            await refreshExpiryData();
            await loadExams();

        } catch (error) {
            toast(error.message);
            button.disabled = false;
        }
    }
);

setInterval(updateExpiryUI, 1000);
setInterval(refreshExpiryData, 5 * 60 * 1000);

async function loadExams() {
    try {
        const exams = await request("/exams");

        setKnownExams(exams);

        const total = exams.reduce(
            (sum, exam) => sum + Number(exam.storage_bytes || 0),
            0
        );

        document.getElementById("examList").innerHTML =
            exams.length
                ? `
                    <p class="muted" style="margin-bottom:16px">
                        Tổng dung lượng: <strong>${formatBytes(total)}</strong>.
                        Mỗi kỳ thi tự động bị xóa sau 7 ngày — bấm "Gia hạn" để giữ lại thêm.
                    </p>
                ` + exams.map(exam => {
                    const expiry = formatExpiry(exam.expires_at);

                    return `
                    <div class="exam-item">
                        <strong>${escapeHTML(exam.name)}</strong>
                        <p>${escapeHTML(exam.description || "")}</p>
                        <small>Mã kỳ thi: <strong>${escapeHTML(exam.code || exam.id)}</strong></small>

                        <p style="margin-top:10px;font-size:18px">
                            Dung lượng: <strong>${formatBytes(exam.storage_bytes)}</strong>
                            · ${exam.submission_count || 0} bài đã chấm
                        </p>

                        <p class="countdown" data-expires="${escapeHTML(exam.expires_at || "")}"
                           style="font-size:18px;font-weight:700;color:${expiry.urgent ? "var(--danger)" : "var(--text-secondary)"}">
                            ${escapeHTML(expiry.text)}
                        </p>

                        <button
                            type="button"
                            class="extend-exam"
                            data-id="${escapeHTML(exam.id)}">
                            Gia hạn thêm 7 ngày
                        </button>

                        <button
                            type="button"
                            class="delete-exam"
                            data-id="${escapeHTML(exam.id)}"
                            data-name="${escapeHTML(exam.name)}">
                            Xóa kỳ thi
                        </button>
                    </div>
                `;
                }).join("")
                : "<p>Chưa có kỳ thi nào.</p>";

    } catch (error) {
        toast(error.message);
    }
}

// GIA HẠN KỲ THI
document.getElementById("examList").addEventListener(
    "click",
    async event => {
        const button = event.target.closest(".extend-exam");

        if (!button) return;

        button.disabled = true;

        try {
            await request(`/exams/${button.dataset.id}/extend`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ days: 7 })
            });

            toast("Đã gia hạn thêm 7 ngày");

            await loadExams();

        } catch (error) {
            toast(error.message);
            button.disabled = false;
        }
    }
);

// TẠO KỲ THI
document.getElementById("examForm").addEventListener(
    "submit",
    async event => {
        event.preventDefault();

        try {
            await request("/exams", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name: document.getElementById("examName").value,
                    description: document.getElementById("examDescription").value
                })
            });

            event.target.reset();

            toast("Tạo kỳ thi thành công");

            await loadExams();
            await loadExamOptions();
            await loadScanExamOptions();
            await loadDashboard();

        } catch (error) {
            toast(error.message);
        }
    }
);

// EXAM OPTIONS
async function loadExamOptions() {
    try {
        const exams = await request("/exams");

        const html = exams.map(exam => `
            <option value="${escapeHTML(exam.id)}">
                ${exam.code ? escapeHTML(exam.code) + " - " : ""}${escapeHTML(exam.name)}${remainingLabel(exam.expires_at)}
            </option>
        `).join("");

        const answerExam = document.getElementById("answerExam");

        answerExam.innerHTML =
            html || '<option value="">Chưa có kỳ thi</option>';

        if (!exams.length) {
            document.getElementById("questionPaper").innerHTML =
                '<option value="">Chưa có mã đề</option>';

            document.getElementById("gradingPaper").innerHTML =
                '<option value="">Chưa có mã đề</option>';
        } else {
            await loadPaperOptions();
        }

    } catch (error) {
        toast(error.message);
    }
}

// CREATE PAPER
document.getElementById("createPaper").addEventListener(
    "click",
    async () => {
        const examId = document.getElementById("answerExam").value;
        const code = document.getElementById("paperCode").value.trim();

        if (!examId || !code) {
            toast("Chọn kỳ thi và nhập mã đề");
            return;
        }

        try {
            await request("/papers", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    exam_id: examId,
                    paper_code: code,
                    title: document.getElementById("paperTitle").value
                })
            });

            document.getElementById("paperStatus").textContent =
                "Tạo mã đề thành công";

            toast("Đã tạo mã đề");

            await loadPaperOptions();

            if (document.getElementById("scanExam").value === examId) {
                await loadScanPaperOptionsForExam(examId);
            }

        } catch (error) {
            document.getElementById("paperStatus").textContent =
                error.message;
        }
    }
);

// PAPER OPTIONS
async function loadPaperOptions() {
    const examId = document.getElementById("answerExam").value;

    if (!examId) {
        document.getElementById("questionPaper").innerHTML =
            '<option value="">Chưa có mã đề</option>';

        document.getElementById("gradingPaper").innerHTML =
            '<option value="">Chưa có mã đề</option>';

        return;
    }

    try {
        const papers = await request(`/exams/${examId}/papers`);

        const html = papers.map(paper => `
            <option value="${escapeHTML(paper.id)}">
                ${escapeHTML(paper.paper_code)} - ${escapeHTML(paper.title || "")}
            </option>
        `).join("") || '<option value="">Chưa có mã đề</option>';

        document.getElementById("questionPaper").innerHTML = html;
        document.getElementById("gradingPaper").innerHTML = html;

    } catch (error) {
        toast(error.message);
    }
}

document.getElementById("answerExam").addEventListener(
    "change",
    loadPaperOptions
);

// SCAN EXAM / PAPER OPTIONS (độc lập với tab Đáp án, tránh chấm nhầm kỳ thi)
async function loadScanExamOptions() {
    try {
        const exams = await request("/exams");

        const scanExamEl = document.getElementById("scanExam");
        const previousValue = scanExamEl.value;

        scanExamEl.innerHTML = exams.length
            ? exams.map(exam => `
                <option value="${escapeHTML(exam.id)}">
                    ${exam.code ? escapeHTML(exam.code) + " - " : ""}${escapeHTML(exam.name)}${remainingLabel(exam.expires_at)}
                </option>
            `).join("")
            : '<option value="">Chưa có kỳ thi</option>';

        if (previousValue && exams.some(exam => exam.id === previousValue)) {
            scanExamEl.value = previousValue;
        }

        await loadScanPaperOptionsForExam(scanExamEl.value);

    } catch (error) {
        toast(error.message);
    }
}

async function loadScanPaperOptionsForExam(examId) {
    const scanPaperEl = document.getElementById("scanPaper");

    if (!examId) {
        scanPaperEl.innerHTML = '<option value="">Chưa có mã đề</option>';
        return;
    }

    try {
        const papers = await request(`/exams/${examId}/papers`);

        const html = papers.map(paper => `
            <option value="${escapeHTML(paper.id)}">
                ${escapeHTML(paper.paper_code)} - ${escapeHTML(paper.title || "")}
            </option>
        `).join("");

        scanPaperEl.innerHTML =
            '<option value="">— Tự động nhận Mã đề —</option>' + html;

    } catch (error) {
        toast(error.message);
    }
}

document.getElementById("scanExam").addEventListener(
    "change",
    event => loadScanPaperOptionsForExam(event.target.value)
);
// ======================================================
// NHẬP ĐÁP ÁN HÀNG LOẠT
// ======================================================

function buildBulkMCQItem(no) {
    return `
        <div class="bulk-item" data-group="mcq" data-no="${no}">
            <label>Câu ${no}</label>
            <input
                type="text"
                maxlength="1"
                class="bulk-mcq-answer"
                data-no="${no}"
                placeholder="A/B/C/D">
        </div>
    `;
}

function buildBulkTFItem(no) {
    return `
        <div class="bulk-item" data-group="tf" data-no="${no}">
            <label>Câu ${no}</label>
            <select class="bulk-tf-answer" data-no="${no}">
                <option value="">-- chọn --</option>
                <option value="Đúng">Đúng</option>
                <option value="Sai">Sai</option>
            </select>
        </div>
    `;
}

// Tạo (hoặc tạo lại) khung nhập với đúng số câu mcqCount/tfCount. Dùng chung
// cho cả nút "Tạo khung nhập" bấm tay, lẫn khi đổ đáp án đọc được từ tài liệu
// vào (lúc đó cần khung đủ lớn trước khi điền giá trị vào từng ô).
function renderBulkGrid(mcqCount, tfCount) {
    const mcqGrid = document.getElementById("bulkMCQGrid");
    const tfGrid = document.getElementById("bulkTFGrid");

    mcqGrid.innerHTML = Array.from({ length: mcqCount }, (_, i) => buildBulkMCQItem(i + 1)).join("");
    tfGrid.innerHTML = Array.from({ length: tfCount }, (_, i) => buildBulkTFItem(i + 1)).join("");

    document.getElementById("bulkMCQSection").hidden = mcqCount === 0;
    document.getElementById("bulkTFSection").hidden = tfCount === 0;
    document.getElementById("bulkFormArea").hidden = false;

    document.getElementById("bulkCountMCQ").value = mcqCount;
    document.getElementById("bulkCountTF").value = tfCount;

    document.getElementById("bulkStatus").textContent = "";
}

document.getElementById("buildBulkGrid").addEventListener(
    "click",
    () => {
        const paperId = document.getElementById("questionPaper").value;

        if (!paperId) {
            toast("Chọn mã đề trước khi tạo khung nhập");
            return;
        }

        const mcqCount = Math.max(0, Number(document.getElementById("bulkCountMCQ").value) || 0);
        const tfCount = Math.max(0, Number(document.getElementById("bulkCountTF").value) || 0);

        if (mcqCount === 0 && tfCount === 0) {
            toast("Nhập số câu lớn hơn 0 ở ít nhất một phần");
            return;
        }

        renderBulkGrid(mcqCount, tfCount);

        toast("Đã tạo khung nhập, điền đáp án rồi bấm Lưu tất cả");
    }
);

// Chỉ nhận dạng mẫu đơn giản "số + chữ cái A-D" cho Phần I, vì Phần II/III
// có quá nhiều cách trình bày khác nhau để đoán đúng tự động mà không gây
// nhầm lẫn. Vẫn cần người dùng tự kiểm tra lại từng ô sau khi điền.
document.getElementById("applyQuickPaste").addEventListener(
    "click",
    () => {
        const text = document.getElementById("bulkQuickPaste").value;
        const regex = /\b(\d{1,3})\s*[.\-:)]?\s*([A-Da-d])\b/g;

        let match;
        let applied = 0;

        while ((match = regex.exec(text)) !== null) {
            const no = Number(match[1]);
            const letter = match[2].toUpperCase();

            const input = document.querySelector(
                `.bulk-mcq-answer[data-no="${no}"]`
            );

            if (input) {
                input.value = letter;
                applied++;
            }
        }

        toast(
            applied > 0
                ? `Đã tự điền ${applied} câu từ văn bản — kiểm tra lại trước khi lưu`
                : "Không nhận dạng được câu nào, kiểm tra lại định dạng văn bản"
        );
    }
);

function collectBulkQuestions() {
    const errors = [];
    const items = [];

    const mcqPoints = Number(document.getElementById("bulkPointsMCQ").value) || 0;
    const tfPoints = Number(document.getElementById("bulkPointsTF").value) || 0;

    document.querySelectorAll("#bulkMCQGrid .bulk-item").forEach(card => {
        const no = Number(card.dataset.no);
        const input = card.querySelector(".bulk-mcq-answer");
        const value = input.value.trim().toUpperCase();

        card.classList.remove("invalid");

        if (!/^[A-D]$/.test(value)) {
            card.classList.add("invalid");
            errors.push(`Phần I - câu ${no}: chưa chọn đáp án hợp lệ (A/B/C/D)`);
            return;
        }

        items.push({
            question_no: no,
            question_type: "MCQ",
            correct_answer: value,
            points: mcqPoints
        });
    });

    document.querySelectorAll("#bulkTFGrid .bulk-item").forEach(card => {
        const no = Number(card.dataset.no);
        const select = card.querySelector(".bulk-tf-answer");
        const value = select.value;

        card.classList.remove("invalid");

        if (value !== "Đúng" && value !== "Sai") {
            card.classList.add("invalid");
            errors.push(`Phần II - câu ${no}: chưa chọn Đúng/Sai`);
            return;
        }

        items.push({
            question_no: no,
            question_type: "TRUE_FALSE",
            correct_answer: value,
            points: tfPoints
        });
    });

    return { items, errors };
}

document.getElementById("saveBulkAnswers").addEventListener(
    "click",
    async () => {
        const paperId = document.getElementById("questionPaper").value;

        if (!paperId) {
            toast("Chọn mã đề trước khi lưu");
            return;
        }

        const { items, errors } = collectBulkQuestions();

        if (errors.length > 0) {
            document.getElementById("bulkStatus").innerHTML =
                `Còn ${errors.length} câu chưa hợp lệ (đã bôi đỏ):<br>` +
                errors.slice(0, 8).map(escapeHTML).join("<br>") +
                (errors.length > 8 ? `<br>... và ${errors.length - 8} câu khác` : "");

            toast("Còn câu chưa hợp lệ, kiểm tra các ô bôi đỏ");
            return;
        }

        try {
            const result = await request(`/papers/${paperId}/questions/bulk`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ questions: items })
            });

            document.getElementById("bulkStatus").textContent = result.message;

            toast("Đã lưu toàn bộ đáp án");

        } catch (error) {
            document.getElementById("bulkStatus").textContent = error.message;
            toast(error.message);
        }
    }
);

// ======================================================
// ĐỌC ĐÁP ÁN TỪ FILE WORD / EXCEL / PDF
// ======================================================

let lastParsedAnswers = []; // [{question_no, question_type, answer}]

document.getElementById("parseDocument").addEventListener(
    "click",
    async () => {
        const file = document.getElementById("documentFile").files[0];

        if (!file) {
            toast("Chọn file Word, Excel hoặc PDF");
            return;
        }

        const form = new FormData();
        form.append("file", file);

        document.getElementById("parseDocumentStatus").textContent = "Đang đọc file...";
        document.getElementById("parseResultArea").hidden = true;

        try {
            const result = await request("/documents/parse-answer-key", {
                method: "POST",
                body: form
            });

            lastParsedAnswers = result.answers || [];

            document.getElementById("documentContent").value = result.raw_preview || "";

            const mcqCount = lastParsedAnswers.filter(a => a.question_type === "MCQ").length;
            const tfCount = lastParsedAnswers.filter(a => a.question_type === "TRUE_FALSE").length;

            document.getElementById("parseResultSummary").textContent =
                `Đọc được ${mcqCount} câu Phần I và ${tfCount} câu Phần II từ "${result.file_name}". ` +
                `Kiểm tra cảnh báo bên dưới (nếu có), rồi bấm "Đổ vào khung nhập để kiểm tra".`;

            const warningsList = document.getElementById("parseWarningsList");

            warningsList.innerHTML = (result.warnings || [])
                .map(w => `<li>${escapeHTML(w)}</li>`)
                .join("");

            document.getElementById("parseResultArea").hidden = false;
            document.getElementById("parseDocumentStatus").textContent = "";

            toast(
                mcqCount + tfCount > 0
                    ? "Đã đọc file, kiểm tra kết quả bên dưới"
                    : "Không đọc được câu nào, xem cảnh báo và văn bản gốc bên dưới"
            );

        } catch (error) {
            document.getElementById("parseDocumentStatus").textContent = error.message;
            toast(error.message);
        }
    }
);

// Đổ các đáp án đọc được từ file vào khung "Nhập đáp án hàng loạt" (tạo lại
// khung đủ lớn nếu cần) để giáo viên xem lại từng câu trước khi lưu — KHÔNG
// lưu thẳng vào CSDL ở bước này.
document.getElementById("applyParsedAnswers").addEventListener(
    "click",
    () => {
        if (lastParsedAnswers.length === 0) {
            toast("Chưa có đáp án nào đọc được từ file");
            return;
        }

        const mcqAnswers = lastParsedAnswers.filter(a => a.question_type === "MCQ");
        const tfAnswers = lastParsedAnswers.filter(a => a.question_type === "TRUE_FALSE");

        const mcqMax = mcqAnswers.reduce((max, a) => Math.max(max, a.question_no), 0);
        const tfMax = tfAnswers.reduce((max, a) => Math.max(max, a.question_no), 0);

        const currentMcq = Math.max(
            mcqMax,
            Number(document.getElementById("bulkCountMCQ").value) || 0
        );
        const currentTf = Math.max(
            tfMax,
            Number(document.getElementById("bulkCountTF").value) || 0
        );

        renderBulkGrid(currentMcq, currentTf);

        for (const a of mcqAnswers) {
            const input = document.querySelector(`.bulk-mcq-answer[data-no="${a.question_no}"]`);
            if (input) input.value = a.answer;
        }

        for (const a of tfAnswers) {
            const select = document.querySelector(`.bulk-tf-answer[data-no="${a.question_no}"]`);
            if (select) select.value = a.answer;
        }

        document.getElementById("bulkFormArea").scrollIntoView({ behavior: "smooth", block: "start" });

        toast("Đã đổ đáp án vào khung nhập — kiểm tra lại từng câu rồi bấm Lưu tất cả");
    }
);

// XEM LẠI ĐÁP ÁN ĐÃ LƯU
document.getElementById("loadSavedAnswers").addEventListener(
    "click",
    async () => {
        const paperId = document.getElementById("questionPaper").value;
        const area = document.getElementById("savedAnswersArea");

        if (!paperId) {
            toast("Chọn mã đề trước");
            return;
        }

        try {
            const list = await request(`/papers/${paperId}/questions`);

            if (list.length === 0) {
                area.innerHTML = "<p class=\"muted\">Mã đề này chưa có đáp án nào.</p>";
                return;
            }

            area.innerHTML = `
                <table class="result-table">
                    <thead>
                        <tr>
                            <th>Câu</th>
                            <th>Phần</th>
                            <th>Đáp án</th>
                            <th>Điểm</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${list.map(q => `
                            <tr>
                                <td>${q.question_no}</td>
                                <td>${q.question_type === "MCQ" ? "Phần I" : "Phần II"}</td>
                                <td>${escapeHTML(
                                    typeof q.correct_answer === "string"
                                        ? q.correct_answer
                                        : JSON.stringify(q.correct_answer)
                                )}</td>
                                <td>${q.points}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            `;

        } catch (error) {
            toast(error.message);
        }
    }
);

// IMAGE PREVIEW
document.getElementById("answerImage").addEventListener(
    "change",
    event => {
        const file = event.target.files[0];

        if (!file) return;

        const preview = document.getElementById("imagePreview");

        preview.src = URL.createObjectURL(file);
        preview.hidden = false;
    }
);

// TẢI ẢNH LÊN -> ĐỌC VÀ CHẤM NGAY TRÊN MÁY (không gửi ảnh lên server để xử lý)
document.getElementById("uploadImage").addEventListener(
    "click",
    async () => {
        const file = document.getElementById("answerImage").files[0];
        const paperId = document.getElementById("gradingPaper").value;
        const examId = document.getElementById("scanExam").value;
        const statusEl = document.getElementById("uploadStatus");
        const btn = document.getElementById("uploadImage");

        if (!file) {
            toast("Chọn ảnh phiếu trả lời");
            return;
        }

        if (!paperId && !examId) {
            toast("Chọn mã đề (hoặc chọn kỳ thi ở phần Quét nhanh để tự nhận mã đề)");
            return;
        }

        btn.disabled = true;

        try {
            const { imageData, originalBlob } = await captureFromFile(file);

            const data = await scanOnDevice({
                imageData,
                originalBlob,
                examId,
                paperId,
                statusEl
            });

            statusEl.textContent =
                "Đã đọc và chấm xong. Mã bài: " + (data.submission_code || data.submission_id);

            scanResultEl.scrollIntoView({ behavior: "smooth", block: "start" });

        } catch (error) {
            statusEl.textContent = error.message;
            toast(error.message);
        } finally {
            btn.disabled = false;
        }
    }
);

// LOAD QUESTIONS FOR STUDENT
async function loadStudentQuestions() {
    const paperId = document.getElementById("gradingPaper").value;

    questions = await request(`/papers/${paperId}/questions`);

    const grid = document.getElementById("studentAnswerGrid");

    grid.innerHTML = questions.map(question => `
        <div class="answer-item">
            <label>
                Câu ${question.question_no}
                (${question.question_type})
            </label>

            <input
                type="text"
                class="student-answer"
                data-id="${escapeHTML(question.id)}"
                placeholder="${question.question_type === "TRUE_FALSE"
                    ? "Đúng hoặc Sai"
                    : "A/B/C/D"}">
        </div>
    `).join("");
}

// SAVE STUDENT ANSWERS
document.getElementById("saveStudentAnswers").addEventListener(
    "click",
    async () => {
        const id = document.getElementById("submissionId").value;

        if (!id) {
            toast("Chưa tải phiếu trả lời");
            return;
        }

        const answers = {};
        const invalid = [];

        document.querySelectorAll(".student-answer").forEach(input => {
            const value = input.value.trim();

            input.classList.remove("invalid-input");

            if (!value) {
                answers[input.dataset.id] = "";
                return;
            }

            const question = questions.find(
                q => q.id === input.dataset.id
            );

            if (question && question.question_type === "TRUE_FALSE") {
                const normalized = normalizeTrueFalseAnswer(value);

                if (!normalized) {
                    input.classList.add("invalid-input");
                    invalid.push(`Câu ${question.question_no}: chỉ nhận "Đúng" hoặc "Sai"`);
                    return;
                }

                answers[input.dataset.id] = normalized;

            } else {
                const upper = value.toUpperCase();

                if (!/^[A-D]$/.test(upper)) {
                    input.classList.add("invalid-input");
                    invalid.push(`Câu ${question ? question.question_no : "?"}: chỉ nhận 1 chữ cái A/B/C/D`);
                    return;
                }

                answers[input.dataset.id] = upper;
            }
        });

        if (invalid.length > 0) {
            toast(`Còn ${invalid.length} câu nhập sai định dạng, kiểm tra ô bôi đỏ`);
            return;
        }

        try {
            await request(`/submissions/${id}/answers`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ answers })
            });

            toast("Đã xác nhận đáp án");

        } catch (error) {
            toast(error.message);
        }
    }
);

// GRADE
document.getElementById("gradeButton").addEventListener(
    "click",
    async () => {
        const id = document.getElementById("submissionId").value;

        if (!id) {
            toast("Chưa có bài làm");
            return;
        }

        try {
            const result = await request(`/submissions/${id}/grade`, {
                method: "POST"
            });

            currentResult = id;

            document.getElementById("gradeStatus").innerHTML = `
                <h3>Điểm: ${result.total_score}/${result.max_score}</h3>
                <p>Đúng: ${result.correct_count}</p>
                <p>Sai: ${result.incorrect_count}</p>
                <p>Bỏ trống: ${result.blank_count}</p>
            `;

            document.getElementById("resultId").value = id;

            toast("Chấm bài thành công");

            showPage("results");
            await displayResult(id);

        } catch (error) {
            document.getElementById("gradeStatus").textContent =
                error.message;
        }
    }
);

// RESULTS
async function displayResult(id) {
    const result = await request(`/results/${id}`);

    currentResult = id;

    if (result.submission_code) {
        document.getElementById("resultId").value = result.submission_code;
    }

    const details = result.detail || [];

    document.getElementById("resultContent").innerHTML = `
        <div class="result-stats">
            <div class="result-box">
                Điểm
                <strong>${result.total_score}/${result.max_score}</strong>
            </div>

            <div class="result-box">
                Đúng
                <strong>${result.correct_count}</strong>
            </div>

            <div class="result-box">
                Sai
                <strong>${result.incorrect_count}</strong>
            </div>

            <div class="result-box">
                Bỏ trống
                <strong>${result.blank_count}</strong>
            </div>
        </div>

        <p style="margin-top:20px">
            Số báo danh: ${escapeHTML(result.student_code || "")}
        </p>

        <table class="result-table">
            <thead>
                <tr>
                    <th>Câu</th>
                    <th>Đáp án thí sinh</th>
                    <th>Đáp án đúng</th>
                    <th>Kết quả</th>
                    <th>Điểm</th>
                </tr>
            </thead>

            <tbody>
                ${details.map(item => `
                    <tr>
                        <td>${item.question_no}</td>

                        <td>${escapeHTML(formatAnswerForDisplay(item.student_answer))}</td>

                        <td>${escapeHTML(formatAnswerForDisplay(item.correct_answer))}</td>

                        <td>${item.student_answer === null ||
                            item.student_answer === ""
                                ? "Bỏ trống"
                                : item.correct ? "Đúng" : "Sai"}</td>

                        <td>${item.points}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

document.getElementById("loadResult").addEventListener(
    "click",
    async () => {
        const id = document.getElementById("resultId").value.trim();

        if (!id) {
            return toast("Nhập mã bài làm");
        }

        try {
            await displayResult(id);

        } catch (error) {
            toast(error.message);
        }
    }
);

// EXPORT EXCEL
document.getElementById("exportResult").addEventListener(
    "click",
    () => {
        const id = currentResult ||
            document.getElementById("resultId").value.trim();

        if (!id) {
            return toast("Chưa có kết quả");
        }

        window.location.href = `${API}/results/${id}/excel`;
    }
);

// ======================================================
// DANH SÁCH ĐIỂM CẢ KỲ THI + XUẤT EXCEL HÀNG LOẠT
// ======================================================

async function loadResultExamOptions() {
    try {
        const exams = await request("/exams");

        const examEl = document.getElementById("resultExam");
        const previous = examEl.value;

        examEl.innerHTML = exams.length
            ? exams.map(exam => `
                <option value="${escapeHTML(exam.id)}">${exam.code ? escapeHTML(exam.code) + " - " : ""}${escapeHTML(exam.name)}${remainingLabel(exam.expires_at)}</option>
            `).join("")
            : '<option value="">Chưa có kỳ thi</option>';

        if (previous && exams.some(exam => exam.id === previous)) {
            examEl.value = previous;
        }

        await loadResultPaperOptions(examEl.value);

    } catch (error) {
        toast(error.message);
    }
}

async function loadResultPaperOptions(examId) {
    const paperEl = document.getElementById("resultPaper");

    if (!examId) {
        paperEl.innerHTML = '<option value="">Tất cả mã đề</option>';
        return;
    }

    try {
        const papers = await request(`/exams/${examId}/papers`);

        paperEl.innerHTML =
            '<option value="">Tất cả mã đề</option>' +
            papers.map(paper => `
                <option value="${escapeHTML(paper.id)}">
                    ${escapeHTML(paper.paper_code)} - ${escapeHTML(paper.title || "")}
                </option>
            `).join("");

    } catch (error) {
        toast(error.message);
    }
}

document.getElementById("resultExam").addEventListener(
    "change",
    event => loadResultPaperOptions(event.target.value)
);

function examResultsQuery() {
    const paperId = document.getElementById("resultPaper").value;

    return paperId ? `?paper_id=${encodeURIComponent(paperId)}` : "";
}

document.getElementById("loadExamResults").addEventListener(
    "click",
    async () => {
        const examId = document.getElementById("resultExam").value;
        const box = document.getElementById("examResultsTable");

        if (!examId) return toast("Chọn kỳ thi");

        try {
            const rows = await request(
                `/exams/${examId}/results${examResultsQuery()}`
            );

            if (!rows.length) {
                box.innerHTML = '<p class="message">Chưa có bài nào được chấm.</p>';
                return;
            }

            box.innerHTML = `
                <p class="muted" style="margin-top:20px">Tổng cộng ${rows.length} bài.</p>
                <table class="result-table">
                    <tr>
                        <th>STT</th><th>Mã bài</th><th>SBD</th><th>Mã đề</th><th>Điểm</th>
                        <th>Đúng</th><th>Sai</th><th>Chưa rõ</th><th>Giờ chấm</th><th></th>
                    </tr>
                    ${rows.map((r, i) => `
                        <tr>
                            <td>${i + 1}</td>
                            <td><strong>${escapeHTML(r.submission_code || "")}</strong></td>
                            <td>${escapeHTML(r.student_code || "(chưa có)")}</td>
                            <td>${escapeHTML(r.paper_code)}</td>
                            <td>${escapeHTML(r.total_score)}/${escapeHTML(r.max_score)}</td>
                            <td>${r.correct_count}</td>
                            <td>${r.incorrect_count}</td>
                            <td>${r.ambiguous_count}</td>
                            <td>${escapeHTML(r.scanned_at_display || "")}</td>
                            <td>
                                <button type="button" class="view-submission"
                                    data-id="${escapeHTML(r.submission_id)}"
                                    data-code="${escapeHTML(r.submission_code || "")}"
                                    style="min-height:40px;padding:6px 14px;margin:0;font-size:16px">
                                    Xem
                                </button>
                            </td>
                        </tr>
                    `).join("")}
                </table>
            `;

            box.querySelectorAll(".view-submission").forEach(btn => {
                btn.addEventListener("click", () => {
                    const id = btn.dataset.id;

                    currentResult = id;
                    document.getElementById("resultId").value = btn.dataset.code || id;
                    displayResult(id);
                });
            });

        } catch (error) {
            toast(error.message);
        }
    }
);

document.getElementById("exportExamResults").addEventListener(
    "click",
    async () => {
        const examId = document.getElementById("resultExam").value;

        if (!examId) return toast("Chọn kỳ thi");

        try {
            const response = await fetch(
                `${API}/exams/${examId}/results/excel${examResultsQuery()}`
            );

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || "Không xuất được file Excel");
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);

            const link = document.createElement("a");
            link.href = url;
            link.download = "danh-sach-diem.xlsx";
            document.body.appendChild(link);
            link.click();
            link.remove();

            setTimeout(() => URL.revokeObjectURL(url), 5000);

        } catch (error) {
            toast(error.message);
        }
    }
);

// SAFE HTML
function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

// Hiển thị đáp án (student_answer / correct_answer) dễ đọc hơn — tất cả đáp
// án giờ đều là chuỗi đơn giản ("A", "Đúng", "Sai"...), không còn JSON object.
function formatAnswerForDisplay(value) {
    if (value === null || value === undefined || value === "") return "(bỏ trống)";

    return typeof value === "string" ? value : JSON.stringify(value);
}

// XÓA KỲ THI
document.getElementById("examList").addEventListener(
    "click",
    async event => {
        const button = event.target.closest(".delete-exam");

        if (!button) return;

        const examId = button.dataset.id;
        const examName = button.dataset.name;

        const confirmed = confirm(
            `Bạn có chắc chắn muốn xóa kỳ thi "${examName}"?\n\n` +
            "Toàn bộ đề thi, câu hỏi, đáp án, bài nộp và kết quả chấm liên quan sẽ bị xóa.\n" +
            "Thao tác này không thể hoàn tác."
        );

        if (!confirmed) return;

        button.disabled = true;

        try {
            await request(`/exams/${examId}`, {
                method: "DELETE"
            });

            toast("Đã xóa kỳ thi thành công");

            await loadExams();
            await loadExamOptions();
            await loadPaperOptions();
            await loadScanExamOptions();
            await loadDashboard();

        } catch (error) {
            console.error(error);
            toast(error.message || "Không thể xóa kỳ thi");
            button.disabled = false;
        }
    }
);

// =====================================================
// QUÉT NHANH BẰNG CAMERA (OMR)
// =====================================================

let scanStream = null;
let scanLoopHandle = null;
let scanBusy = false;
let lastSmallFrame = null;
let steadyFrames = 0;

const scanVideo = document.getElementById("scanVideo");
const scanCanvas = document.getElementById("scanCanvas");
const startScanBtn = document.getElementById("startScan");
const captureNowBtn = document.getElementById("captureNow");
const stopScanBtn = document.getElementById("stopScan");
const scanOverlayHint = document.getElementById("scanOverlayHint");
const scanGuide = document.getElementById("scanGuide");
const scanStatusEl = document.getElementById("scanStatus");
const scanFlash = document.getElementById("scanFlash");
const nextScanBtn = document.getElementById("nextScan");

// Quét liên tục: sau khi chấm xong camera vẫn mở, chờ phiếu cũ rời khung
// rồi mới chấm bài tiếp theo (tránh chấm lặp cùng một phiếu).
let needRearm = false;
let rearmMisses = 0;
let scanHistory = [];
const scanResultEl = document.getElementById("scanResult");

async function startScan() {
    if (!navigator.mediaDevices?.getUserMedia) {
        toast("Trình duyệt này không hỗ trợ camera (cần HTTPS hoặc localhost)");
        return;
    }

    try {
        scanStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1920 },
                height: { ideal: 1920 }
            },
            audio: false
        });

        scanVideo.srcObject = scanStream;
        scanVideo.hidden = false;
        scanOverlayHint.hidden = false;
        scanGuide.hidden = false;
        scanGuide.classList.remove("ok");
        startScanBtn.hidden = true;
        captureNowBtn.hidden = false;
        stopScanBtn.hidden = false;
        scanResultEl.hidden = true;
        scanStatusEl.textContent = "Đang chờ phiếu vào khung hình...";

        scanBusy = false;
        steadyFrames = 0;
        lastSmallFrame = null;
        needRearm = false;
        rearmMisses = 0;
        scanFlash.hidden = true;

        if (scanLoopHandle) clearInterval(scanLoopHandle);
        scanLoopHandle = setInterval(checkFrameForAutoCapture, 450);

    } catch (error) {
        toast("Không mở được camera: " + error.message);
    }
}

function stopScan() {
    if (scanLoopHandle) {
        clearInterval(scanLoopHandle);
        scanLoopHandle = null;
    }

    if (scanStream) {
        scanStream.getTracks().forEach(track => track.stop());
        scanStream = null;
    }

    scanVideo.hidden = true;
    scanOverlayHint.hidden = true;
    scanGuide.hidden = true;
    scanFlash.hidden = true;
    nextScanBtn.hidden = true;
    needRearm = false;
    startScanBtn.hidden = false;
    captureNowBtn.hidden = true;
    stopScanBtn.hidden = true;
}

function getSmallFrameData() {
    const SMALL_W = 160;
    const ratio = (scanVideo.videoHeight / scanVideo.videoWidth) || 1;
    const smallH = Math.max(1, Math.round(SMALL_W * ratio));

    const tmp = document.createElement("canvas");
    tmp.width = SMALL_W;
    tmp.height = smallH;

    const ctx = tmp.getContext("2d");
    ctx.drawImage(scanVideo, 0, 0, SMALL_W, smallH);

    return ctx.getImageData(0, 0, SMALL_W, smallH);
}

// Ước lượng độ "chi tiết" (edge) và độ sáng trung bình của khung hình,
// thuần JS (không dùng thư viện), để biết khi nào phiếu đã vào khung và
// đứng yên đủ để chụp nét.
function frameScore(imageData) {
    const { data, width, height } = imageData;

    let edgeSum = 0;
    let brightnessSum = 0;
    const count = width * height;

    for (let y = 1; y < height; y++) {
        for (let x = 1; x < width; x++) {
            const i = (y * width + x) * 4;
            const iLeft = (y * width + (x - 1)) * 4;
            const iUp = ((y - 1) * width + x) * 4;

            const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
            const grayLeft = (data[iLeft] + data[iLeft + 1] + data[iLeft + 2]) / 3;
            const grayUp = (data[iUp] + data[iUp + 1] + data[iUp + 2]) / 3;

            edgeSum += Math.abs(gray - grayLeft) + Math.abs(gray - grayUp);
            brightnessSum += gray;
        }
    }

    return {
        edge: edgeSum / count,
        brightness: brightnessSum / count
    };
}

function frameDiff(a, b) {
    if (!a || !b || a.data.length !== b.data.length) return Infinity;

    let diff = 0;
    let samples = 0;

    for (let i = 0; i < a.data.length; i += 16) {
        diff += Math.abs(a.data[i] - b.data[i]);
        samples++;
    }

    return diff / samples;
}

// ------------------------------------------------------------------
// KHUNG HƯỚNG DẪN: 4 ô vuông ứng với tâm 4 ô đen ở góc phiếu.
// Tỉ lệ khung = khoảng cách giữa các ô đen góc trên phiếu gốc
// (439.6 x 649.5 pt, đo từ file PDF).
// ------------------------------------------------------------------
const GUIDE_ASPECT = 439.6 / 649.5;
let guideGeom = null;

function layoutScanGuide() {
    if (!scanVideo.videoWidth) return;

    const boxW = scanVideo.clientWidth;
    const boxH = scanVideo.clientHeight;
    const vw = scanVideo.videoWidth;
    const vh = scanVideo.videoHeight;

    if (!boxW || !boxH) return;

    // video dùng object-fit: contain -> tính vùng hình thật sự hiển thị
    const scale = Math.min(boxW / vw, boxH / vh);
    const contentW = vw * scale;
    const contentH = vh * scale;
    const offX = (boxW - contentW) / 2;
    const offY = (boxH - contentH) / 2;

    let gh = contentH * 0.84;
    let gw = gh * GUIDE_ASPECT;

    if (gw > contentW * 0.84) {
        gw = contentW * 0.84;
        gh = gw / GUIDE_ASPECT;
    }

    const gx = offX + (contentW - gw) / 2;
    const gy = offY + (contentH - gh) / 2;

    scanGuide.style.left = gx + "px";
    scanGuide.style.top = gy + "px";
    scanGuide.style.width = gw + "px";
    scanGuide.style.height = gh + "px";
    scanGuide.style.setProperty(
        "--sq",
        Math.max(22, Math.min(46, gw * 0.09)) + "px"
    );

    guideGeom = { scale, offX, offY, gx, gy, gw, gh };
}

scanVideo.addEventListener("loadedmetadata", layoutScanGuide);
scanVideo.addEventListener("resize", layoutScanGuide);
scanVideo.addEventListener("playing", layoutScanGuide);
window.addEventListener("resize", layoutScanGuide);

// Kiểm tra có ô đen thật nằm trong 4 ô vuông hướng dẫn hay không: lấy một
// cửa sổ nhỏ quanh mỗi góc, tìm điểm mà vùng tâm TỐI hơn rõ rệt so với
// vòng nền xung quanh (không phụ thuộc độ sáng tuyệt đối).
const markerProbe = document.createElement("canvas");
markerProbe.width = 64;
markerProbe.height = 64;
const markerProbeCtx = markerProbe.getContext("2d", { willReadFrequently: true });

function cornerHasMarker(vx, vy, winVideo) {
    markerProbeCtx.drawImage(
        scanVideo,
        vx - winVideo / 2, vy - winVideo / 2, winVideo, winVideo,
        0, 0, 64, 64
    );

    const { data } = markerProbeCtx.getImageData(0, 0, 64, 64);
    const gray = new Float32Array(64 * 64);

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }

    const RING = 12;
    const ringOffsets = [];

    for (let k = 0; k < 16; k++) {
        const ang = (k * Math.PI) / 8;
        ringOffsets.push([Math.cos(ang) * RING, Math.sin(ang) * RING]);
    }

    let best = 0;

    for (let cy = 16; cy <= 48; cy += 2) {
        for (let cx = 16; cx <= 48; cx += 2) {
            let center = 0;
            let n = 0;

            for (let dy = -3; dy <= 3; dy++) {
                for (let dx = -3; dx <= 3; dx++) {
                    if (dx * dx + dy * dy > 9) continue;
                    center += gray[(cy + dy) * 64 + (cx + dx)];
                    n++;
                }
            }

            center /= n;

            let ring = 0;

            for (const [ox, oy] of ringOffsets) {
                ring += gray[Math.round(cy + oy) * 64 + Math.round(cx + ox)];
            }

            ring /= ringOffsets.length;

            const contrast = (ring - center) / Math.max(ring, 1);

            if (contrast > best) best = contrast;
        }
    }

    return best >= 0.45;
}

function countGuideMatches() {
    if (!guideGeom) return 0;

    const { scale, offX, offY, gx, gy, gw, gh } = guideGeom;

    const toVideo = (ex, ey) => [(ex - offX) / scale, (ey - offY) / scale];
    const winVideo = (gw / scale) * 0.16;

    const corners = [
        [gx, gy],
        [gx + gw, gy],
        [gx, gy + gh],
        [gx + gw, gy + gh]
    ];

    let matched = 0;

    for (const [ex, ey] of corners) {
        const [vx, vy] = toVideo(ex, ey);

        if (cornerHasMarker(vx, vy, winVideo)) matched++;
    }

    return matched;
}

async function checkFrameForAutoCapture() {
    if (scanBusy || !scanVideo.videoWidth) return;

    layoutScanGuide();

    const current = getSmallFrameData();
    const { brightness } = frameScore(current);

    if (brightness < 25 || brightness > 245) {
        steadyFrames = 0;
        lastSmallFrame = current;
        scanGuide.classList.remove("ok");
        scanStatusEl.textContent = "Ánh sáng chưa đủ tốt, chỉnh lại góc chụp...";
        return;
    }

    const matched = countGuideMatches();

    if (needRearm) {
        // Vừa chấm xong: chờ phiếu cũ rời khỏi khung rồi mới sẵn sàng bài tiếp
        if (matched < 4) {
            rearmMisses++;
        } else {
            rearmMisses = 0;
        }

        if (rearmMisses >= 2) {
            readyForNextScan();
        } else {
            scanStatusEl.textContent =
                "Đã chấm xong. Lấy phiếu ra rồi đặt phiếu tiếp theo vào khung...";
        }

        return;
    }

    if (matched < 4) {
        steadyFrames = 0;
        lastSmallFrame = current;
        scanGuide.classList.remove("ok");
        scanStatusEl.textContent =
            `Đặt 4 ô đen của phiếu vào 4 ô vuông trên màn hình (khớp ${matched}/4)`;
        return;
    }

    scanGuide.classList.add("ok");

    const diff = frameDiff(lastSmallFrame, current);
    lastSmallFrame = current;

    if (diff < 6) {
        steadyFrames++;
    } else {
        steadyFrames = 0;
    }

    if (steadyFrames >= 2) {
        scanStatusEl.textContent = "Đã khớp 4 góc và rõ nét, đang chụp...";
        await captureAndSend();
    } else {
        scanStatusEl.textContent = "Đã khớp 4 góc, giữ yên tay...";
    }
}

// ======================================================
// ĐỌC PHIẾU NGAY TRÊN MÁY NGƯỜI DÙNG (điện thoại / trình duyệt)
// Ảnh không cần gửi lên server: trình duyệt tự nhận diện phiếu, đọc SBD, mã
// đề, đáp án; server chỉ nhận kết quả đọc để chấm theo đáp án rồi lưu.
// ======================================================
const OMR_MAX_SIDE = 2000;

let omrWorker = null;
let omrJobId = 0;
const omrPending = new Map();

function getOmrWorker() {
    if (omrWorker) return omrWorker;

    try {
        omrWorker = new Worker("omr/omr-worker.js");

        omrWorker.onmessage = event => {
            const job = omrPending.get(event.data.id);

            if (!job) return;

            omrPending.delete(event.data.id);

            if (event.data.error) job.reject(new Error(event.data.error));
            else job.resolve(event.data.result);
        };

        omrWorker.onerror = () => {
            // worker lỗi: chuyển sang xử lý trực tiếp trên luồng chính
            for (const job of omrPending.values()) {
                const failure = new Error("Worker lỗi");

                failure.workerFailed = true;
                job.reject(failure);
            }

            omrPending.clear();
            omrWorker = null;
        };
    } catch (error) {
        omrWorker = null;
    }

    return omrWorker;
}

function runOmr(imageData) {
    const worker = getOmrWorker();

    // Không có / không tải được worker: xử lý ngay trên luồng chính
    const runInline = () => Promise.resolve().then(() => window.OMR.processImage(imageData));

    if (!worker) return runInline();

    return new Promise((resolve, reject) => {
        const id = ++omrJobId;

        omrPending.set(id, { resolve, reject });

        // gửi BẢN SAO sang worker để còn dữ liệu gốc dùng cho phương án dự phòng
        const copy = imageData.data.buffer.slice(0);

        worker.postMessage(
            { id, width: imageData.width, height: imageData.height, buffer: copy },
            [copy]
        );
    }).catch(error => {
        if (error && error.workerFailed) return runInline();

        throw error;
    });
}

function canvasToJpegBlob(canvas, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
}

// Vẽ nguồn (video / ảnh) vào canvas RIÊNG của lần này (không dùng chung, để
// hai thao tác chồng nhau không ghi đè lên ảnh của nhau), thu nhỏ nếu quá lớn
function drawToWorkCanvas(source, sourceWidth, sourceHeight) {
    const scale = Math.min(1, OMR_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);

    const canvas = document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    ctx.drawImage(source, 0, 0, width, height);

    return { canvas, ctx, width, height };
}

async function captureFromVideo() {
    const { canvas, ctx, width, height } = drawToWorkCanvas(
        scanVideo,
        scanVideo.videoWidth,
        scanVideo.videoHeight
    );

    const imageData = ctx.getImageData(0, 0, width, height);
    const originalBlob = await canvasToJpegBlob(canvas, 0.8);

    return { imageData, originalBlob };
}

async function captureFromFile(file) {
    let bitmap;

    try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (error) {
        bitmap = await createImageBitmap(file);
    }

    const { canvas, ctx, width, height } = drawToWorkCanvas(bitmap, bitmap.width, bitmap.height);

    if (bitmap.close) bitmap.close();

    const imageData = ctx.getImageData(0, 0, width, height);
    const originalBlob = await canvasToJpegBlob(canvas, 0.8);

    return { imageData, originalBlob };
}

function omrFailureMessage(omr) {
    if (omr.reason === "no_markers") {
        return "Không thấy các ô vuông đen của phiếu trong ảnh. Đưa cả tờ phiếu " +
            "vào khung, đủ sáng, rồi chụp lại.";
    }

    return `Ảnh chưa đủ chuẩn để đọc chính xác (khớp ${omr.passed}/${omr.total} ô đối chứng, ` +
        `cần ít nhất ${window.OMR.MIN_PASSED}). Hãy chụp lại: để phiếu phẳng, thấy đủ 4 ô đen ` +
        "ở góc và 2 ô đen giữa hai mép, không bị bóng đổ hay chói sáng, không chụp quá xa.";
}

// Vẽ vòng màu lên ảnh phiếu đã nắn phẳng (xanh: đúng, đỏ: sai, vàng: chưa rõ)
async function buildAnnotatedBlob(omr, details) {
    const warped = omr.warped;
    const canvas = document.createElement("canvas");

    canvas.width = warped.w;
    canvas.height = warped.h;

    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(warped.w, warped.h);

    for (let i = 0; i < warped.gray.length; i++) {
        const v = warped.gray[i];

        image.data[i * 4] = v;
        image.data[i * 4 + 1] = v;
        image.data[i * 4 + 2] = v;
        image.data[i * 4 + 3] = 255;
    }

    ctx.putImageData(image, 0, 0);
    ctx.lineWidth = 3;

    const COLORS = {
        correct: "#22c55e",
        incorrect: "#dc2626",
        faint: "#eab308",
        multiple: "#eab308"
    };

    const radius = window.OMR.RADIUS + 5;
    const readByNo = new Map(omr.questions.map(q => [q.question_no, q]));

    const circle = (bubble, color) => {
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(bubble.x, bubble.y, radius, 0, Math.PI * 2);
        ctx.stroke();
    };

    for (const detail of details) {
        const bubbles = window.OMR.TEMPLATE.questionBubbles.get(detail.question_no);
        const read = readByNo.get(detail.question_no);

        if (!bubbles || !read) continue;

        if (detail.mark_status === "multiple") {
            bubbles.forEach((bubble, i) => {
                if ((read.scores[i] ?? 0) >= 0.12) circle(bubble, COLORS.multiple);
            });

            continue;
        }

        const chosen = read.choice ? bubbles.find(b => b.choice === read.choice) : null;
        const color = COLORS[detail.mark_status];

        if (chosen && color) circle(chosen, color);
    }

    return canvasToJpegBlob(canvas, 0.88);
}

async function uploadSubmissionImages(submissionId, annotatedBlob, originalBlob) {
    const form = new FormData();

    if (annotatedBlob) form.append("annotated", annotatedBlob, "annotated.jpg");
    if (originalBlob) form.append("original", originalBlob, "original.jpg");

    const response = await fetch(`${API}/submissions/${submissionId}/images`, {
        method: "POST",
        body: form
    });

    if (!response.ok) throw new Error("Không lưu được ảnh bài thi");
}

/**
 * Toàn bộ luồng: đọc phiếu trên máy -> gửi kết quả đọc để chấm -> vẽ ảnh chú
 * thích -> hiện điểm ngay -> gửi ảnh lên lưu ở nền.
 */
async function scanOnDevice({ imageData, originalBlob, examId, paperId, statusEl }) {
    statusEl.textContent = "Đang đọc phiếu...";

    const omr = await runOmr(imageData);

    if (!omr.ok) throw new Error(omrFailureMessage(omr));

    statusEl.textContent = "Đang chấm điểm...";

    const payload = {
        sbd: omr.sbd,
        ma_de: omr.maDe,
        alignment: { passed: omr.passed, total: omr.total },
        questions: omr.questions.map(q => ({
            question_no: q.question_no,
            choice: q.choice,
            status: q.status
        }))
    };

    if (paperId) payload.paper_id = paperId;
    else payload.exam_id = examId;

    const response = await fetch(`${API}/submissions/scan-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        let message = data.error || "Không chấm được, thử chụp lại";

        if (data.detected_paper_code) {
            message += ` (đọc được mã đề: ${data.detected_paper_code})`;
        }

        throw new Error(message);
    }

    // hiện ảnh đã chấm ngay (chưa cần chờ lưu lên server)
    const annotatedBlob = await buildAnnotatedBlob(omr, data.grading.details);

    showScanResult(data);

    document.getElementById("annotatedImage").src = URL.createObjectURL(annotatedBlob);

    uploadSubmissionImages(data.submission_id, annotatedBlob, originalBlob)
        .catch(error => toast(error.message));

    return data;
}

function resumeAutoScanLoop() {
    scanBusy = false;

    if (!scanLoopHandle && scanStream) {
        scanLoopHandle = setInterval(checkFrameForAutoCapture, 450);
    }
}

async function captureAndSend() {
    if (scanBusy) return;

    scanBusy = true;
    steadyFrames = 0;

    if (scanLoopHandle) {
        clearInterval(scanLoopHandle);
        scanLoopHandle = null;
    }

    try {
        const examId = document.getElementById("scanExam").value;
        const paperId = document.getElementById("scanPaper").value;

        if (!examId) {
            toast("Chọn kỳ thi trước khi quét");
            resumeAutoScanLoop();
            return;
        }

        const { imageData, originalBlob } = await captureFromVideo();

        let data;

        try {
            data = await scanOnDevice({
                imageData,
                originalBlob,
                examId,
                paperId,
                statusEl: scanStatusEl
            });
        } catch (error) {
            scanStatusEl.textContent = error.message;
            toast(error.message);
            beep("error");

            lastSmallFrame = null;
            resumeAutoScanLoop();
            return;
        }

        addScanHistory(data);
        showScanFlash(data);
        beep("ok");

        // Giữ camera mở để chấm bài tiếp theo
        needRearm = true;
        rearmMisses = 0;
        lastSmallFrame = null;
        nextScanBtn.hidden = false;
        scanStatusEl.textContent =
            `Đã chấm xong lúc ${data.scanned_at_display}. Lấy phiếu ra rồi đặt phiếu tiếp theo vào khung.`;

        resumeAutoScanLoop();

    } catch (error) {
        toast(error.message);
        beep("error");
        resumeAutoScanLoop();
    }
}

function showScanResult(data) {
    currentSubmission = data.submission_id;
    currentResult = data.submission_id;

    document.getElementById("submissionId").value = data.submission_id;
    document.getElementById("resultId").value =
        data.submission_code || data.submission_id;

    document.getElementById("scanScore").textContent =
        `${data.grading.total_score}/${data.grading.max_score}`;

    document.getElementById("scanCorrect").textContent =
        data.grading.correct_count;

    document.getElementById("scanIncorrect").textContent =
        data.grading.incorrect_count;

    document.getElementById("scanAmbiguous").textContent =
        data.grading.ambiguous_count ?? 0;

    document.getElementById("scanDetected").textContent =
        `Mã bài: ${data.submission_code || ""} · Mã đề: ${data.paper.paper_code}` +
        ` · SBD: ${data.detected.student_code || "(không đọc được)"}` +
        (data.detected.student_code_status !== "filled"
            ? " (nên kiểm tra lại SBD)"
            : "");

    if (data.annotated_image_url) {
        document.getElementById("annotatedImage").src =
            data.annotated_image_url + "?t=" + Date.now();
    }

    document.getElementById("scanSbdEdit").value =
        data.student_code || data.detected.student_code || "";

    if (data.duplicate_count > 0) {
        document.getElementById("scanDetected").textContent +=
            ` · ⚠ SBD này đã được chấm ${data.duplicate_count} lần trước đó`;
    }

    if (data.scanned_at_display) {
        document.getElementById("scanDetected").textContent +=
            ` · Lúc ${data.scanned_at_display}`;
    }

    scanResultEl.hidden = false;

    toast("Chấm bài thành công");
}

// ---------- Hiện điểm ngay trên camera ----------
function showScanFlash(data) {
    const g = data.grading;

    const needsReview =
        (g.ambiguous_count ?? 0) > 0 ||
        data.detected.student_code_status !== "filled" ||
        data.duplicate_count > 0;

    document.getElementById("flashScore").textContent =
        `${g.total_score}/${g.max_score}`;

    document.getElementById("flashInfo").textContent =
        `SBD ${data.student_code || data.detected.student_code || "(chưa đọc)"}` +
        ` · Mã đề ${data.paper.paper_code}` +
        ` · Bài ${data.submission_code || ""}` +
        (needsReview ? " · ⚠ cần xem lại" : "");

    scanFlash.classList.toggle("warn", needsReview);
    scanFlash.hidden = false;
}

function readyForNextScan() {
    needRearm = false;
    rearmMisses = 0;
    steadyFrames = 0;
    lastSmallFrame = null;
    scanFlash.hidden = true;
    nextScanBtn.hidden = true;
    scanStatusEl.textContent = "Sẵn sàng — đặt bài tiếp theo vào khung";
}

nextScanBtn.addEventListener("click", readyForNextScan);

// ---------- Âm báo ----------
let audioCtx = null;

function beep(kind) {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.frequency.value = kind === "ok" ? 880 : 220;
        gain.gain.value = 0.08;

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start();
        osc.stop(audioCtx.currentTime + (kind === "ok" ? 0.12 : 0.3));
    } catch (e) { /* không có âm thanh cũng không sao */ }
}

// ---------- Danh sách bài đã chấm trong phiên ----------
function addScanHistory(data) {
    scanHistory.unshift({
        id: data.submission_id,
        code: data.submission_code || "",
        time: data.scanned_at_display || "",
        sbd: data.student_code || data.detected.student_code || "(chưa đọc)",
        paper: data.paper.paper_code,
        score: `${data.grading.total_score}/${data.grading.max_score}`
    });

    renderScanHistory();
}

function renderScanHistory() {
    const table = document.getElementById("scanHistoryTable");

    document.getElementById("scanHistoryBox").hidden = scanHistory.length === 0;

    table.innerHTML = `
        <tr>
            <th>STT</th><th>Mã bài</th><th>Giờ chấm</th><th>SBD</th><th>Mã đề</th><th>Điểm</th><th></th>
        </tr>
        ${scanHistory.map((row, i) => `
            <tr>
                <td>${scanHistory.length - i}</td>
                <td><strong>${escapeHTML(row.code)}</strong></td>
                <td>${escapeHTML(row.time)}</td>
                <td>${escapeHTML(row.sbd)}</td>
                <td>${escapeHTML(row.paper)}</td>
                <td>${escapeHTML(row.score)}</td>
                <td>
                    <button type="button" class="view-scan-history"
                        data-id="${escapeHTML(row.id)}"
                        style="min-height:40px;padding:6px 14px;margin:0;font-size:16px">
                        Xem ảnh
                    </button>
                </td>
            </tr>
        `).join("")}
    `;
}

document.getElementById("scanHistoryTable").addEventListener("click", event => {
    const button = event.target.closest(".view-scan-history");

    if (!button) return;

    const id = button.dataset.id;
    const row = scanHistory.find(r => r.id === id);

    currentSubmission = id;
    currentResult = id;

    document.getElementById("annotatedImage").src =
        `${API}/submissions/${id}/annotated-image?t=${Date.now()}`;

    document.getElementById("scanSbdEdit").value =
        row && row.sbd !== "(chưa đọc)" ? row.sbd : "";

    scanResultEl.hidden = false;
    scanResultEl.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- Sửa SBD sau khi quét ----------
document.getElementById("saveScanSbd").addEventListener("click", async () => {
    if (!currentSubmission) return toast("Chưa có bài nào để lưu SBD");

    const code = document.getElementById("scanSbdEdit").value.trim();

    try {
        await request(`/submissions/${currentSubmission}/student-code`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ student_code: code })
        });

        const row = scanHistory.find(r => r.id === currentSubmission);

        if (row) {
            row.sbd = code || "(chưa đọc)";
            renderScanHistory();
        }

        toast("Đã lưu số báo danh");

    } catch (error) {
        toast(error.message);
    }
});

startScanBtn.addEventListener("click", startScan);
stopScanBtn.addEventListener("click", stopScan);

captureNowBtn.addEventListener("click", () => {
    scanStatusEl.textContent = "Đang chụp...";
    captureAndSend();
});

// ======================================================
// CHỌN THEME (màu chính - màu phụ), nhớ lựa chọn trên trình duyệt này
// ======================================================
(function setupThemePicker() {
    const select = document.getElementById("themeSelect");

    let saved = "sang-xanh";

    try {
        saved = localStorage.getItem("quizTheme") || "sang-xanh";
    } catch (e) { /* trình duyệt chặn lưu: dùng mặc định */ }

    if (![...select.options].some(o => o.value === saved)) saved = "sang-xanh";

    select.value = saved;
    document.documentElement.dataset.theme = saved;

    select.addEventListener("change", () => {
        document.documentElement.dataset.theme = select.value;

        try {
            localStorage.setItem("quizTheme", select.value);
        } catch (e) { /* bỏ qua */ }
    });
})();

// INIT
async function init() {
    try {
        await request("/health");
        refreshExpiryData();

        await loadDashboard();
        await loadExams();
        await loadExamOptions();
        await loadPaperOptions();
        await loadScanExamOptions();

        console.log("QuizGrader initialized");

    } catch (error) {
        toast("Không thể kết nối máy chủ: " + error.message);
        console.error(error);
    }
}

init();