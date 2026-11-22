/**
 * Lõi đọc phiếu trả lời trắc nghiệm — CHẠY TRONG TRÌNH DUYỆT (và cả Node để
 * kiểm thử). Không phụ thuộc thư viện nào.
 *
 * Đầu vào : ImageData / {width, height, data(RGBA)}
 * Đầu ra  : SBD, mã đề, đáp án từng câu (kèm trạng thái đậm/mờ/nhiều ô),
 *           và ảnh phiếu đã nắn phẳng (xám) để vẽ chú thích.
 *
 * Các bước: dò mọi ô vuông đen -> thử các bộ 4 góc, chọn bộ làm 8 ô đối chứng
 * khớp nhất -> tinh chỉnh bằng tất cả ô đen -> nắn phẳng -> đọc ô tròn.
 */
(function (root) {
"use strict";

// ====================== TEMPLATE (đo từ PDF gốc) ======================

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

const TEMPLATE = {
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


// ====================== HÌNH HỌC ======================
function solveLinearSystem(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
        let pivotRow = col;
        let maxAbs = Math.abs(M[col][col]);

        for (let r = col + 1; r < n; r++) {
            if (Math.abs(M[r][col]) > maxAbs) {
                maxAbs = Math.abs(M[r][col]);
                pivotRow = r;
            }
        }

        if (maxAbs < 1e-12) {
            throw new Error("Hệ phương trình suy biến, không giải được homography");
        }

        [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

        const pivot = M[col][col];

        for (let c = col; c <= n; c++) {
            M[col][c] /= pivot;
        }

        for (let r = 0; r < n; r++) {
            if (r === col) continue;

            const factor = M[r][col];

            if (factor === 0) continue;

            for (let c = col; c <= n; c++) {
                M[r][c] -= factor * M[col][c];
            }
        }
    }

    return M.map(row => row[n]);
}


function computeHomography(srcPoints, dstPoints) {
    if (srcPoints.length !== 4 || dstPoints.length !== 4) {
        throw new Error("computeHomography cần đúng 4 cặp điểm");
    }

    const A = [];
    const b = [];

    for (let i = 0; i < 4; i++) {
        const { x, y } = srcPoints[i];
        const { x: X, y: Y } = dstPoints[i];

        A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
        b.push(X);

        A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
        b.push(Y);
    }

    const h = solveLinearSystem(A, b);

    return {
        h11: h[0], h12: h[1], h13: h[2],
        h21: h[3], h22: h[4], h23: h[5],
        h31: h[6], h32: h[7], h33: 1
    };
}


// ---------- Homography bình phương tối thiểu (dùng nhiều hơn 4 cặp điểm) ----------

function normalizationMatrix(points) {
    const n = points.length;
    let cx = 0, cy = 0;

    for (const p of points) { cx += p.x; cy += p.y; }

    cx /= n;
    cy /= n;

    let meanDist = 0;

    for (const p of points) meanDist += Math.hypot(p.x - cx, p.y - cy);

    meanDist /= n;

    const s = meanDist > 0 ? Math.SQRT2 / meanDist : 1;

    return { s, cx, cy };
}

function mul3(A, B) {
    const R = [[0,0,0],[0,0,0],[0,0,0]];

    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++) R[i][j] += A[i][k] * B[k][j];

    return R;
}

/**
 * Giống computeHomography nhưng nhận từ 4 cặp điểm trở lên và tìm nghiệm
 * khớp nhất theo bình phương tối thiểu (có chuẩn hóa tọa độ để ổn định số).
 */
function computeHomographyLS(srcPoints, dstPoints) {
    const n = srcPoints.length;

    if (n < 4 || dstPoints.length !== n) {
        throw new Error("computeHomographyLS cần ít nhất 4 cặp điểm");
    }

    const ts = normalizationMatrix(srcPoints);
    const td = normalizationMatrix(dstPoints);

    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);

    const addRow = (row, rhs) => {
        for (let i = 0; i < 8; i++) {
            Atb[i] += row[i] * rhs;

            for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
        }
    };

    for (let i = 0; i < n; i++) {
        const x = (srcPoints[i].x - ts.cx) * ts.s;
        const y = (srcPoints[i].y - ts.cy) * ts.s;
        const X = (dstPoints[i].x - td.cx) * td.s;
        const Y = (dstPoints[i].y - td.cy) * td.s;

        addRow([x, y, 1, 0, 0, 0, -x * X, -y * X], X);
        addRow([0, 0, 0, x, y, 1, -x * Y, -y * Y], Y);
    }

    const h = solveLinearSystem(AtA, Atb);

    const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];

    // H = Td^-1 * Hn * Ts
    const Ts = [[ts.s, 0, -ts.s * ts.cx], [0, ts.s, -ts.s * ts.cy], [0, 0, 1]];
    const TdInv = [[1 / td.s, 0, td.cx], [0, 1 / td.s, td.cy], [0, 0, 1]];

    const H = mul3(TdInv, mul3(Hn, Ts));

    const k = H[2][2] || 1;

    return {
        h11: H[0][0] / k, h12: H[0][1] / k, h13: H[0][2] / k,
        h21: H[1][0] / k, h22: H[1][1] / k, h23: H[1][2] / k,
        h31: H[2][0] / k, h32: H[2][1] / k, h33: 1
    };
}


function applyHomography(H, x, y) {
    const w = H.h31 * x + H.h32 * y + H.h33;

    return {
        x: (H.h11 * x + H.h12 * y + H.h13) / w,
        y: (H.h21 * x + H.h22 * y + H.h23) / w
    };
}



// ====================== ẢNH XÁM ======================
function toGray(img) {
    const w = img.width, h = img.height, d = img.data;
    const gray = new Uint8Array(w * h);

    for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
        gray[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    }

    return { w, h, gray };
}

// thu nhỏ bằng trung bình hộp
function downscaleGray(G, newW) {
    const scale = newW / G.w;
    const newH = Math.max(1, Math.round(G.h * scale));
    const out = new Uint8Array(newW * newH);
    const fx = G.w / newW, fy = G.h / newH;

    for (let y = 0; y < newH; y++) {
        const y0 = Math.floor(y * fy), y1 = Math.min(G.h, Math.max(y0 + 1, Math.floor((y + 1) * fy)));

        for (let x = 0; x < newW; x++) {
            const x0 = Math.floor(x * fx), x1 = Math.min(G.w, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
            let sum = 0, n = 0;

            for (let yy = y0; yy < y1; yy++) {
                const row = yy * G.w;

                for (let xx = x0; xx < x1; xx++) { sum += G.gray[row + xx]; n++; }
            }

            out[y * newW + x] = sum / n;
        }
    }

    return { w: newW, h: newH, gray: out };
}

// nội suy song tuyến: 0 = đen, 255 = trắng; ngoài ảnh = trắng
function sampleGray(G, x, y) {
    const w = G.w, h = G.h;

    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 255;

    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = x - x0, fy = y - y0, g = G.gray;

    const top = g[y0 * w + x0] * (1 - fx) + g[y0 * w + x1] * fx;
    const bottom = g[y1 * w + x0] * (1 - fx) + g[y1 * w + x1] * fx;

    return top * (1 - fy) + bottom * fy;
}

// ====================== KIỂM TRA CĂN CHỈNH (ô đen đối chứng) ======================
const MIN_CONTRAST = 0.35;
const CENTER_R = 6;
const MIN_PASSED = 6;

function avgAround(G, H, cx, cy, r) {
    let total = 0, n = 0;

    for (let k = -1; k < 8; k++) {
        const dx = k < 0 ? 0 : Math.cos((k * Math.PI) / 4) * r;
        const dy = k < 0 ? 0 : Math.sin((k * Math.PI) / 4) * r;
        const p = applyHomography(H, cx + dx, cy + dy);

        total += sampleGray(G, p.x, p.y);
        n++;
    }

    return total / n;
}

function countPassed(G, H) {
    let passed = 0;
    const contrasts = [];

    for (const m of TEMPLATE.checkMarks) {
        const center = avgAround(G, H, m.x, m.y, CENTER_R);
        const ring = avgAround(G, H, m.x, m.y, m.ringR);
        const contrast = (ring - center) / Math.max(ring, 1);

        contrasts.push(Number(contrast.toFixed(2)));

        if (contrast >= MIN_CONTRAST) passed++;
    }

    return { passed, contrasts };
}

// ====================== DÒ Ô VUÔNG ĐEN ======================
const WORK_WIDTH = 1000;
const THRESHOLDS = [70, 100, 130, 160];
const MAX_CANDIDATES = 30;
const SHEET_RATIO = 439.645 / 649.5;

function adaptiveMask(gray, w, h) {
    const win = Math.max(15, Math.round(w / 12));
    const integral = new Float64Array((w + 1) * (h + 1));

    for (let y = 0; y < h; y++) {
        let rowSum = 0;

        for (let x = 0; x < w; x++) {
            rowSum += gray[y * w + x];
            integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
        }
    }

    const mask = new Uint8Array(w * h);
    const half = win >> 1;

    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);

        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
            const sum =
                integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] -
                integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
            const mean = sum / ((x1 - x0) * (y1 - y0));
            const v = gray[y * w + x];

            mask[y * w + x] = v < mean * 0.55 && v < 140 ? 1 : 0;
        }
    }

    return mask;
}

function blobsFromMask(mask, w, h) {
    const visited = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const blobs = [];

    for (let start = 0; start < w * h; start++) {
        if (!mask[start] || visited[start]) continue;

        let sp = 0;
        stack[sp++] = start;
        visited[start] = 1;

        let minX = w, maxX = 0, minY = h, maxY = 0, area = 0, sumX = 0, sumY = 0;

        while (sp > 0) {
            const cur = stack[--sp];
            const cx = cur % w, cy = (cur - cx) / w;

            area++; sumX += cx; sumY += cy;

            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;

            if (cx > 0 && mask[cur - 1] && !visited[cur - 1]) { visited[cur - 1] = 1; stack[sp++] = cur - 1; }
            if (cx < w - 1 && mask[cur + 1] && !visited[cur + 1]) { visited[cur + 1] = 1; stack[sp++] = cur + 1; }
            if (cy > 0 && mask[cur - w] && !visited[cur - w]) { visited[cur - w] = 1; stack[sp++] = cur - w; }
            if (cy < h - 1 && mask[cur + w] && !visited[cur + w]) { visited[cur + w] = 1; stack[sp++] = cur + w; }
        }

        blobs.push({
            area, minX, maxX, minY, maxY,
            cx: sumX / area, cy: sumY / area,
            width: maxX - minX + 1, height: maxY - minY + 1
        });
    }

    return blobs;
}

function candidateScore(b, w, h) {
    if (b.area < 16 || b.area > 0.01 * w * h) return null;
    if (b.minX <= 0 || b.minY <= 0 || b.maxX >= w - 1 || b.maxY >= h - 1) return null;

    const fill = b.area / (b.width * b.height);
    const aspect = b.width / b.height;

    if (fill < 0.62 || aspect < 0.55 || aspect > 1.8) return null;

    const squareness = 1 - Math.min(1, Math.abs(1 - aspect));

    return fill * 0.5 + squareness * 0.5 + Math.min(1, Math.sqrt(b.area) / 12) * 0.1;
}

function findCandidates(G) {
    const scale = Math.min(1, WORK_WIDTH / G.w);
    const S = scale < 1 ? downscaleGray(G, Math.round(G.w * scale)) : G;
    const { gray, w, h } = S;

    const masks = THRESHOLDS.map(t => {
        const m = new Uint8Array(w * h);

        for (let i = 0; i < m.length; i++) m[i] = gray[i] < t ? 1 : 0;

        return m;
    });

    masks.push(adaptiveMask(gray, w, h));

    const all = [];

    for (const mask of masks) {
        for (const blob of blobsFromMask(mask, w, h)) {
            const score = candidateScore(blob, w, h);

            if (score !== null) all.push(Object.assign({ score }, blob));
        }
    }

    all.sort((a, b) => b.score - a.score);

    const kept = [];

    for (const c of all) {
        const dup = kept.some(k =>
            Math.hypot(k.cx - c.cx, k.cy - c.cy) < 0.7 * Math.max(Math.sqrt(k.area), Math.sqrt(c.area)));

        if (!dup) kept.push(c);

        if (kept.length >= MAX_CANDIDATES) break;
    }

    // đổi về tọa độ ảnh gốc (tâm điểm ảnh = +0.5 theo quy ước lấy mẫu: giữ nguyên chỉ số)
    return kept.map(c => ({ x: (c.cx + 0.5) / scale - 0.5, y: (c.cy + 0.5) / scale - 0.5, size: Math.sqrt(c.area) / scale }));
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const ALL_MARKERS = [
    TEMPLATE.markers.top_left, TEMPLATE.markers.top_right,
    TEMPLATE.markers.bottom_right, TEMPLATE.markers.bottom_left
].concat(TEMPLATE.checkMarks.map(m => ({ x: m.x, y: m.y })));

function locateSheet(G) {
    const candidates = findCandidates(G);
    const total = TEMPLATE.checkMarks.length;

    if (candidates.length < 4) {
        return { ok: false, passed: 0, total, candidates: candidates.length, reason: "no_markers" };
    }

    const T = TEMPLATE.markers;
    const templateCorners = [T.top_left, T.top_right, T.bottom_right, T.bottom_left];

    let best = null;
    const n = candidates.length;

    outer:
    for (let a = 0; a < n - 3; a++)
    for (let b = a + 1; b < n - 2; b++)
    for (let c = b + 1; c < n - 1; c++)
    for (let d = c + 1; d < n; d++) {
        const quad = [candidates[a], candidates[b], candidates[c], candidates[d]];
        const sizes = quad.map(q => q.size);

        if (Math.max.apply(null, sizes) / Math.min.apply(null, sizes) > 2.2) continue;

        const mx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
        const my = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

        quad.sort((p, q) => Math.atan2(p.y - my, p.x - mx) - Math.atan2(q.y - my, q.x - mx));

        const signs = [0, 1, 2, 3].map(i => Math.sign(cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4])));

        if (!signs.every(s => s === signs[0] && s !== 0)) continue;

        const ratio = dist(quad[0], quad[1]) / dist(quad[1], quad[2]);

        for (let shift = 0; shift < 4; shift++) {
            const expected = shift % 2 === 0 ? SHEET_RATIO : 1 / SHEET_RATIO;

            if (ratio < expected * 0.6 || ratio > expected * 1.6) continue;

            let H;

            try {
                H = computeHomography(templateCorners, templateCorners.map((_, i) => quad[(i + shift) % 4]));
            } catch (e) { continue; }

            const r = countPassed(G, H);

            if (!best || r.passed > best.passed) {
                best = { H, passed: r.passed, contrasts: r.contrasts, quad: templateCorners.map((_, i) => quad[(i + shift) % 4]) };
            }

            if (best.passed === total) break outer;
        }
    }

    if (!best) return { ok: false, passed: 0, total, candidates: candidates.length, reason: "no_quad" };

    // tinh chỉnh bằng tất cả ô đen khớp được
    const tol = Math.max(8, 0.025 * dist(best.quad[0], best.quad[1]));
    const refs = [], srcs = [];

    for (const m of ALL_MARKERS) {
        const p = applyHomography(best.H, m.x, m.y);
        let near = null, nearD = Infinity;

        for (const c of candidates) {
            const dd = Math.hypot(c.x - p.x, c.y - p.y);

            if (dd < nearD) { nearD = dd; near = c; }
        }

        if (near && nearD <= tol) { refs.push({ x: m.x, y: m.y }); srcs.push({ x: near.x, y: near.y }); }
    }

    let finalH = best.H, passed = best.passed, contrasts = best.contrasts;

    if (refs.length >= 6) {
        try {
            const refined = computeHomographyLS(refs, srcs);
            const check = countPassed(G, refined);

            if (check.passed >= passed) { finalH = refined; passed = check.passed; contrasts = check.contrasts; }
        } catch (e) { /* giữ nghiệm 4 góc */ }
    }

    return {
        ok: passed >= MIN_PASSED, H: finalH, passed, total, contrasts,
        matched: refs.length, candidates: candidates.length,
        reason: passed >= MIN_PASSED ? undefined : "misaligned"
    };
}

// ====================== NẮN PHẲNG ======================
function warpGray(G, H, outW, outH) {
    const out = new Uint8ClampedArray(outW * outH);

    for (let ty = 0; ty < outH; ty++) {
        for (let tx = 0; tx < outW; tx++) {
            const p = applyHomography(H, tx, ty);

            out[ty * outW + tx] = Math.round(sampleGray(G, p.x, p.y));
        }
    }

    return { w: outW, h: outH, gray: out };
}

// ====================== ĐỌC Ô TRÒN ======================
const RADIUS = Math.max(2, Math.round(TEMPLATE.bubbleRadiusFrac * TEMPLATE.REF_W));
const BLANK_THRESHOLD = 0.12;
const CONFIDENT_THRESHOLD = 0.30;
const AMBIGUITY_MARGIN = 0.08;

// Độ "tô đậm" của một ô, đo TƯƠNG ĐỐI so với vòng nền ngay quanh ô đó, nên
// không bị ảnh hưởng khi ảnh tối / sáng không đều / có vân moiré.
const BG_RING_R = 18;

function bubbleFillScore(W, cx, cy) {
    let total = 0, count = 0;

    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
            if (dx * dx + dy * dy > RADIUS * RADIUS) continue;

            total += sampleGray(W, cx + dx, cy + dy);
            count++;
        }
    }

    const center = total / count;

    let ring = 0;

    for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4 + Math.PI / 8;

        ring += sampleGray(W, cx + Math.cos(a) * BG_RING_R, cy + Math.sin(a) * BG_RING_R);
    }

    const bg = Math.max(ring / 8, 60);

    return Math.max(0, Math.min(1, (bg - center) / bg));
}

function classify(scores) {
    let maxIdx = 0, max = -Infinity, second = -Infinity;

    scores.forEach((s, i) => {
        if (s > max) { second = max; max = s; maxIdx = i; }
        else if (s > second) second = s;
    });

    if (max < BLANK_THRESHOLD) return { status: "blank", index: null };
    if (second >= BLANK_THRESHOLD && max - second < AMBIGUITY_MARGIN) return { status: "multiple", index: null };
    if (max < CONFIDENT_THRESHOLD) return { status: "faint", index: maxIdx };

    return { status: "filled", index: maxIdx };
}

function readDigits(W, columns) {
    const cols = columns.map(column => {
        const scores = column.map(cell => bubbleFillScore(W, cell.x, cell.y));
        const r = classify(scores);

        return { status: r.status, digit: r.index === null ? null : column[r.index].digit };
    });

    const allBlank = cols.every(c => c.status === "blank");
    const anyMultiple = cols.some(c => c.status === "multiple");
    const anyWeak = cols.some(c => c.status === "faint" || c.status === "blank");

    return {
        value: cols.map(c => (c.digit === null ? "?" : String(c.digit))).join(""),
        status: allBlank ? "blank" : anyMultiple ? "multiple" : anyWeak ? "faint" : "filled"
    };
}

function readAllQuestions(W) {
    const result = [];

    TEMPLATE.questionBubbles.forEach((bubbles, questionNo) => {
        const scores = bubbles.map(b => bubbleFillScore(W, b.x, b.y));
        const r = classify(scores);

        result.push({
            question_no: questionNo,
            status: r.status,
            choice: r.index === null ? null : bubbles[r.index].choice,
            scores: scores.map(s => Number(s.toFixed(3)))
        });
    });

    return result.sort((a, b) => a.question_no - b.question_no);
}

// ====================== HÀM CHÍNH ======================
/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} imageData
 */
function processImage(imageData) {
    const t0 = Date.now();
    const G = toGray(imageData);
    const located = locateSheet(G);

    const info = {
        ok: located.ok, reason: located.reason, passed: located.passed, total: located.total,
        contrasts: located.contrasts, matched: located.matched, candidates: located.candidates,
        imageWidth: imageData.width, imageHeight: imageData.height
    };

    if (!located.ok) {
        info.ms = Date.now() - t0;

        return info;
    }

    const W = warpGray(G, located.H, TEMPLATE.REF_W, TEMPLATE.REF_H);

    info.sbd = readDigits(W, TEMPLATE.sbdColumns);
    info.maDe = readDigits(W, TEMPLATE.maDeColumns);
    info.questions = readAllQuestions(W);
    info.warped = W;
    info.ms = Date.now() - t0;

    return info;
}

const OMR = {
    processImage, TEMPLATE, RADIUS, MIN_PASSED,
    _internal: { toGray, locateSheet, warpGray, readDigits, readAllQuestions, findCandidates }
};

if (typeof module !== "undefined" && module.exports) module.exports = OMR;
else root.OMR = OMR;

})(typeof self !== "undefined" ? self : this);
