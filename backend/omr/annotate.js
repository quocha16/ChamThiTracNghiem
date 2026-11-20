/**
 * Vẽ vòng tròn màu lên ảnh bài thi đã chấm:
 *  - Xanh lá: câu trả lời đúng
 *  - Đỏ: câu trả lời sai
 *  - Vàng: câu tô mờ / tô nhiều hơn 1 ô (không chắc chắn, cần xem lại tay)
 *  - Bỏ trống: không vẽ gì
 */

const { RADIUS } = require("./bubbleRead");

const MIN_VISIBLE_SCORE = 0.12;

function drawCircle(image, Jimp, cx, cy, radius, colorInt, thickness = 3) {
    const rOuter = radius + thickness / 2;
    const rInner = Math.max(0, radius - thickness / 2);

    const w = image.bitmap.width;
    const h = image.bitmap.height;

    const minX = Math.max(0, Math.floor(cx - rOuter));
    const maxX = Math.min(w - 1, Math.ceil(cx + rOuter));
    const minY = Math.max(0, Math.floor(cy - rOuter));
    const maxY = Math.min(h - 1, Math.ceil(cy + rOuter));

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);

            if (d >= rInner && d <= rOuter) {
                image.setPixelColor(colorInt, x, y);
            }
        }
    }
}

/**
 * @param {Object} Jimp class Jimp đã require ở nơi gọi
 * @param {Object} baseImage ảnh Jimp (đã warp) làm nền
 * @param {Array} questionDetails kết quả chấm điểm có kèm bubbles/scores/mark_status
 *   (lấy từ bubbleRead.readQuestions kết hợp với grading.gradeExam detail)
 */
function annotateImage(Jimp, baseImage, questionDetails) {
    const image = baseImage.clone();

    const GREEN = Jimp.rgbaToInt(34, 197, 94, 255);
    const RED = Jimp.rgbaToInt(220, 38, 38, 255);
    const YELLOW = Jimp.rgbaToInt(234, 179, 8, 255);

    for (const detail of questionDetails) {
        if (!detail.bubbles || !detail.bubbles.length) continue;

        if (detail.mark_status === "multiple") {
            detail.bubbles.forEach((bubble, i) => {
                if ((detail.scores[i] ?? 0) >= MIN_VISIBLE_SCORE) {
                    drawCircle(image, Jimp, bubble.x, bubble.y, RADIUS + 5, YELLOW);
                }
            });
            continue;
        }

        // gradeExam không trả về "choice" -> dùng student_answer (chữ cái A-D)
        const choiceLetter = detail.choice || detail.student_answer;

        const chosen = choiceLetter
            ? detail.bubbles.find(b => b.choice === choiceLetter)
            : null;

        if (!chosen) continue; // blank hoặc không xác định được ô nào

        if (detail.mark_status === "faint") {
            drawCircle(image, Jimp, chosen.x, chosen.y, RADIUS + 5, YELLOW);
        } else if (detail.mark_status === "correct") {
            drawCircle(image, Jimp, chosen.x, chosen.y, RADIUS + 5, GREEN);
        } else if (detail.mark_status === "incorrect") {
            drawCircle(image, Jimp, chosen.x, chosen.y, RADIUS + 5, RED);
        }
    }

    return image;
}

module.exports = { annotateImage, drawCircle };