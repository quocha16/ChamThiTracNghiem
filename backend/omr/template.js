/**
 * Mô tả hình học (template) của phiếu trả lời trắc nghiệm, ĐO CHÍNH XÁC từ
 * file PDF gốc "Form40_VI_6SBD_NOLABEL.pdf" (khổ A4 595.28 x 841.89 pt):
 * tâm 4 ô vuông đen ở góc và tâm từng ô tròn được lấy trực tiếp từ các đối
 * tượng vector của PDF, rồi quy đổi sang hệ tọa độ tham chiếu REF_W x REF_H
 * bằng phép đồng dạng (tỉ lệ 2 px/pt, không méo hình).
 *
 *   REF_X = 60.5  + (x_pdf - 83.055)  * 2
 *   REF_Y = 57.5  + (y_pdf - 103.195) * 2
 *
 * Nếu phiếu thật được in/scan đúng tỉ lệ PDF gốc thì không cần chỉnh gì.
 * Nếu in bị co giãn, dùng POST /api/omr/calibration-preview để kiểm tra.
 */

const REF_W = 1000;
const REF_H = 1414;

// 4 ô vuông đen ở 4 góc (tâm), dùng để tính homography.
const markers = {
    top_left:     { x: 60.5,  y: 57.5 },
    top_right:    { x: 939.79, y: 57.5 },
    bottom_left:  { x: 60.5,  y: 1356.5 },
    bottom_right: { x: 939.79, y: 1356.5 }
};

// Bán kính lấy mẫu (~60% bán kính ô tròn 13.9 px REF, tránh viền ô).
const bubbleRadiusFrac = 0.0083;

// Tọa độ cột / hàng (hệ REF) của từng khối, đo từ PDF.
const SBD_COLS   = [178.57, 214.07, 249.57, 285.37, 320.79, 357.09];
const MADE_COLS  = [432.99, 468.57, 504.15];
const TOP_ROWS   = [441.57, 481.35, 523.53, 564.25, 607.11, 648.35, 690.27, 731.05, 773.93, 814.41];   // dùng chung cho SBD, Mã đề, câu 1-10
const Q1_COLS    = [651.53, 687.01, 722.83, 758.23];
const BOT_ROWS   = [898.69, 938.47, 980.65, 1021.37, 1064.23, 1105.47, 1147.39, 1188.15, 1231.05, 1271.53];   // dùng chung cho câu 11-40
const Q11_COLS   = [214.11, 249.61, 285.43, 320.83];
const Q21_COLS   = [433.03, 468.51, 504.33, 539.73];
const Q31_COLS   = [651.53, 687.01, 722.83, 758.23];


// Các ô đen "đối chứng" (2 ô lớn giữa hai mép + 6 ô nhỏ) dùng để KIỂM TRA
// phiếu đã được nắn đúng hướng/đúng vị trí trước khi đọc đáp án.
const checkMarks = [
    { x: 60.5, y: 706.67, ringR: 42 },
    { x: 939.79, y: 706.67, ringR: 42 },
    { x: 392.19, y: 402.21, ringR: 17 },
    { x: 611.39, y: 402.21, ringR: 17 },
    { x: 392.19, y: 857.91, ringR: 17 },
    { x: 611.39, y: 857.91, ringR: 17 },
    { x: 392.19, y: 1313.61, ringR: 17 },
    { x: 611.39, y: 1313.61, ringR: 17 }
];

const CHOICES = ["A", "B", "C", "D"];

// 4 khối câu hỏi, mỗi khối 10 câu x 4 đáp án (A B C D)
const questionBlocks = [
    { firstQuestion: 1,  cols: Q1_COLS,  rows: TOP_ROWS },
    { firstQuestion: 11, cols: Q11_COLS, rows: BOT_ROWS },
    { firstQuestion: 21, cols: Q21_COLS, rows: BOT_ROWS },
    { firstQuestion: 31, cols: Q31_COLS, rows: BOT_ROWS }
];

function buildQuestionBubbles() {
    // Map: question_no -> [{choice, x, y}, ...]
    const map = new Map();

    for (const block of questionBlocks) {
        block.rows.forEach((y, i) => {
            map.set(
                block.firstQuestion + i,
                CHOICES.map((choice, c) => ({ choice, x: block.cols[c], y }))
            );
        });
    }

    return map;
}

const questionBubbles = buildQuestionBubbles();

// columns[col] = [{digit, x, y}, ... digit 0..9 theo hàng]
function digitColumns(cols) {
    return cols.map(x =>
        TOP_ROWS.map((y, digit) => ({ digit, x, y }))
    );
}

module.exports = {
    REF_W,
    REF_H,
    markers,
    checkMarks,
    bubbleRadiusFrac,
    sbdColumns: digitColumns(SBD_COLS),
    maDeColumns: digitColumns(MADE_COLS),
    questionBubbles,
    CHOICES,
    maxQuestion: 40
};