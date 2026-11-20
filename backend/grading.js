function normalize(value) {
    if (value === null || value === undefined) return "";

    return String(value)
        .trim()
        .toLowerCase()
        .replace(",", ".");
}

function isCorrect(student, correct) {
    if (Array.isArray(correct)) {
        if (!Array.isArray(student)) return false;

        return JSON.stringify(
            student.map(normalize).sort()
        ) === JSON.stringify(
            correct.map(normalize).sort()
        );
    }

    if (student && typeof student === "object" &&
        !Array.isArray(student)) {
        if (!correct || typeof correct !== "object") {
            return false;
        }

        const keys = Object.keys(correct);

        return keys.every(
            key => normalize(student[key]) === normalize(correct[key])
        );
    }

    return normalize(student) === normalize(correct);
}

/**
 * Chấm điểm một bài làm.
 *
 * @param {Array} questions danh sách câu hỏi (kèm đáp án chuẩn, điểm)
 * @param {Object} answers map question_id -> đáp án học sinh
 * @param {Object} [markStatus] map question_id -> 'filled'|'blank'|'multiple'|'faint'
 *   Dùng cho bài chấm bằng camera (OMR): 'multiple' (tô nhiều hơn 1 ô) hoặc
 *   'faint' (tô quá mờ/nhạt, độ tin cậy thấp) sẽ được đánh dấu "chưa rõ"
 *   (ambiguous) thay vì chấm đúng/sai, để giáo viên xem lại thủ công.
 *   Khi không truyền (chấm thủ công như trước), mọi câu đều được chấm như
 *   hành vi cũ (đúng/sai/bỏ trống).
 */
function gradeExam(questions, answers, markStatus = {}) {
    let correctCount = 0;
    let incorrectCount = 0;
    let blankCount = 0;
    let ambiguousCount = 0;
    let totalScore = 0;
    let maxScore = 0;

    const details = [];

    for (const question of questions) {
        const studentAnswer = answers[question.id];
        const correctAnswer = question.correct_answer;
        const points = Number(question.points || 0);
        const status = markStatus[question.id];

        maxScore += points;

        const blank =
            status === "blank" ||
            studentAnswer === null ||
            studentAnswer === undefined ||
            studentAnswer === "" ||
            (typeof studentAnswer === "object" &&
             !Array.isArray(studentAnswer) &&
             Object.values(studentAnswer).every(v => !String(v || "").trim()));

        const ambiguous = status === "multiple" || status === "faint";

        let correct = false;
        let resultStatus;

        if (ambiguous) {
            ambiguousCount++;
            resultStatus = status; // 'multiple' hoặc 'faint'
        } else if (blank) {
            blankCount++;
            resultStatus = "blank";
        } else {
            correct = isCorrect(studentAnswer, correctAnswer);

            if (correct) {
                correctCount++;
                totalScore += points;
                resultStatus = "correct";
            } else {
                incorrectCount++;
                resultStatus = "incorrect";
            }
        }

        details.push({
            question_id: question.id,
            question_no: question.question_no,
            question_type: question.question_type,
            student_answer: studentAnswer ?? null,
            correct_answer: correctAnswer,
            correct,
            mark_status: resultStatus,
            points: correct ? points : 0,
            max_points: points
        });
    }

    return {
        total_questions: questions.length,
        correct_count: correctCount,
        incorrect_count: incorrectCount,
        blank_count: blankCount,
        ambiguous_count: ambiguousCount,
        total_score: Number(totalScore.toFixed(3)),
        max_score: Number(maxScore.toFixed(3)),
        details
    };
}

module.exports = { gradeExam, isCorrect };
