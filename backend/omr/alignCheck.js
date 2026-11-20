/**
 * Kiểm tra phiếu đã được nắn đúng (đúng hướng, đúng tỉ lệ) hay chưa, TRƯỚC
 * khi đọc đáp án. Ảnh chụp có thể xoay 90/180/270 độ, nên thử cả 4 cách gán
 * 4 ô góc và chọn cách khiến các ô đen đối chứng (checkMarks) khớp nhất.
 *
 * Mỗi ô đối chứng được đánh giá bằng độ tương phản: vùng tâm phải TỐI hơn
 * rõ rệt so với vòng nền xung quanh (không phụ thuộc độ sáng tuyệt đối).
 */

const { computeHomography, applyHomography, sampleGray } = require("./geometry");
const { markers: templateMarkers, checkMarks } = require("./template");

const MIN_CONTRAST = 0.35;
const CENTER_R = 6;

// template corner -> khóa ô góc tìm thấy trên ảnh, ứng với từng hướng xoay
const ORIENTATIONS = [
    { rotation: 0,   map: { top_left: "top_left", top_right: "top_right", bottom_left: "bottom_left", bottom_right: "bottom_right" } },
    { rotation: 180, map: { top_left: "bottom_right", top_right: "bottom_left", bottom_left: "top_right", bottom_right: "top_left" } },
    { rotation: 90,  map: { top_left: "top_right", top_right: "bottom_right", bottom_left: "top_left", bottom_right: "bottom_left" } },
    { rotation: 270, map: { top_left: "bottom_left", top_right: "top_left", bottom_left: "bottom_right", bottom_right: "top_right" } }
];

function avgAround(image, H, cx, cy, r) {
    let total = 0;
    let n = 0;

    const offsets = [[0, 0]];

    for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        offsets.push([Math.cos(a) * r, Math.sin(a) * r]);
    }

    for (const [dx, dy] of offsets) {
        const p = applyHomography(H, cx + dx, cy + dy);

        total += sampleGray(image, p.x, p.y);
        n++;
    }

    return total / n;
}

function countPassed(image, H) {
    let passed = 0;

    for (const m of checkMarks) {
        const center = avgAround(image, H, m.x, m.y, CENTER_R);
        const ring = avgAround(image, H, m.x, m.y, m.ringR);
        const contrast = (ring - center) / Math.max(ring, 1);

        if (contrast >= MIN_CONTRAST) passed++;
    }

    return passed;
}

function buildH(detected, map) {
    const keys = ["top_left", "top_right", "bottom_left", "bottom_right"];

    return computeHomography(
        keys.map(k => templateMarkers[k]),
        keys.map(k => detected[map[k]])
    );
}

/**
 * @returns {{H:Object, rotation:number, passed:number, total:number}}
 */
function chooseOrientation(image, detectedMarkers) {
    let best = null;

    for (const o of ORIENTATIONS) {
        let H;

        try {
            H = buildH(detectedMarkers, o.map);
        } catch (e) {
            continue;
        }

        const passed = countPassed(image, H);

        if (!best || passed > best.passed) {
            best = { H, rotation: o.rotation, passed, total: checkMarks.length };
        }

        if (passed === checkMarks.length) break;
    }

    return best;
}

module.exports = { chooseOrientation, MIN_PASSED: 6 };
