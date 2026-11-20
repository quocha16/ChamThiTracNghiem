/**
 * Đọc độ tô đậm của từng ô tròn trên ảnh đã "duỗi thẳng" (warped) về hệ
 * tọa độ tham chiếu của template, rồi quyết định học sinh đã chọn đáp án
 * nào, hay bỏ trống / tô nhiều ô / tô quá mờ (không chắc chắn).
 */

const {
    REF_W,
    bubbleRadiusFrac,
    sbdColumns,
    maDeColumns,
    questionBubbles
} = require("./template");

const { sampleGray } = require("./geometry");

const RADIUS = Math.max(2, Math.round(bubbleRadiusFrac * REF_W));

// Ngưỡng phân loại (0 = trắng tuyệt đối, 1 = đen tuyệt đối)
const BLANK_THRESHOLD = 0.12;     // dưới mức này coi như chưa tô gì
const CONFIDENT_THRESHOLD = 0.30; // trên mức này mới coi là "tô chắc chắn"
const AMBIGUITY_MARGIN = 0.08;    // 2 ô gần bằng nhau -> không phân biệt được

function bubbleFillScore(image, cx, cy) {
    let total = 0;
    let count = 0;

    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
            if (dx * dx + dy * dy > RADIUS * RADIUS) continue;

            total += sampleGray(image, cx + dx, cy + dy);
            count++;
        }
    }

    const avgGray = total / count;

    return 1 - avgGray / 255;
}

function classify(scores) {
    let maxIdx = 0;
    let max = -Infinity;
    let secondMax = -Infinity;

    scores.forEach((s, i) => {
        if (s > max) {
            secondMax = max;
            max = s;
            maxIdx = i;
        } else if (s > secondMax) {
            secondMax = s;
        }
    });

    if (max < BLANK_THRESHOLD) {
        return { status: "blank", index: null, scores };
    }

    if (secondMax >= BLANK_THRESHOLD && max - secondMax < AMBIGUITY_MARGIN) {
        return { status: "multiple", index: null, scores };
    }

    if (max < CONFIDENT_THRESHOLD) {
        return { status: "faint", index: maxIdx, scores };
    }

    return { status: "filled", index: maxIdx, scores };
}

function readDigitColumns(image, columns) {
    return columns.map(column => {
        const scores = column.map(cell => bubbleFillScore(image, cell.x, cell.y));
        const result = classify(scores);

        return {
            status: result.status,
            digit: result.index === null ? null : column[result.index].digit,
            cell: result.index === null ? null : column[result.index],
            scores: result.scores,
            column
        };
    });
}

function combineDigits(columnResults) {
    const anyMultiple = columnResults.some(c => c.status === "multiple");
    const anyFaint = columnResults.some(c => c.status === "faint");
    const anyBlank = columnResults.some(c => c.status === "blank");
    const allBlank = columnResults.every(c => c.status === "blank");

    let overallStatus;

    if (allBlank) overallStatus = "blank";
    else if (anyMultiple) overallStatus = "multiple";
    else if (anyFaint || anyBlank) overallStatus = "faint";
    else overallStatus = "filled";

    const value = columnResults
        .map(c => (c.digit === null ? "?" : String(c.digit)))
        .join("");

    return { value, status: overallStatus, columns: columnResults };
}

function readSBD(image) {
    return combineDigits(readDigitColumns(image, sbdColumns));
}

function readMaDe(image) {
    return combineDigits(readDigitColumns(image, maDeColumns));
}

/**
 * Đọc đáp án cho các câu hỏi thực sự có trong đề (không đọc dư nếu đề có
 * ít câu hơn số lượng in sẵn trên phiếu, ví dụ đề 30 câu / phiếu in 40 câu).
 *
 * @param {Object} image Jimp image đã warp về hệ REF_W x REF_H
 * @param {Array} questionsInPaper [{id, question_no}, ...]
 */
function readQuestions(image, questionsInPaper) {
    const details = [];

    for (const q of questionsInPaper) {
        const bubbles = questionBubbles.get(q.question_no);

        if (!bubbles) {
            // Câu không nằm trong vùng hỗ trợ của template (vd > 40)
            details.push({
                question_id: q.id,
                question_no: q.question_no,
                status: "blank",
                choice: null,
                bubbles: [],
                scores: []
            });
            continue;
        }

        const scores = bubbles.map(b => bubbleFillScore(image, b.x, b.y));
        const result = classify(scores);

        details.push({
            question_id: q.id,
            question_no: q.question_no,
            status: result.status,
            choice: result.index === null ? null : bubbles[result.index].choice,
            bubbles,
            scores: result.scores
        });
    }

    return details;
}

module.exports = {
    bubbleFillScore,
    classify,
    readSBD,
    readMaDe,
    readQuestions,
    RADIUS
};
