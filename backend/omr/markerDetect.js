/**
 * Phát hiện 4 ô vuông đen ở góc phiếu trả lời trong một ảnh chụp bằng
 * điện thoại (có thể nghiêng/xoay/phối cảnh nhẹ).
 *
 * Thuật toán (thuần JS, không cần OpenCV):
 *  1. Thu nhỏ ảnh để xử lý nhanh.
 *  2. Nhị phân hóa theo ngưỡng độ sáng (thử nhiều ngưỡng).
 *  3. Gán nhãn vùng liên thông (connected components / flood fill).
 *  4. Lọc các vùng "giống hình vuông đặc" (tỉ lệ lấp đầy cao, gần vuông).
 *  5. Với mỗi góc ảnh (trên-trái, trên-phải, dưới-trái, dưới-phải), chọn
 *     vùng ứng viên gần góc đó nhất / điểm số tốt nhất.
 *  6. Quy đổi tọa độ tâm vùng về độ phân giải gốc của ảnh.
 */

const Jimp = require("jimp");

const DOWNSCALE_WIDTH = 700;
const THRESHOLDS = [70, 90, 110, 130, 150];

function buildGrayscaleBuffer(image) {
    const w = image.bitmap.width;
    const h = image.bitmap.height;
    const gray = new Uint8ClampedArray(w * h);
    const { data } = image.bitmap;

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        gray[p] = Math.round(
            data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
        );
    }

    return { gray, w, h };
}

function findDarkBlobs(gray, w, h, threshold) {
    const visited = new Uint8Array(w * h);
    const blobs = [];

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;

            if (visited[idx] || gray[idx] >= threshold) continue;

            // BFS (iterative) flood fill
            const stack = [idx];
            visited[idx] = 1;

            let minX = x, maxX = x, minY = y, maxY = y;
            let area = 0;
            let sumX = 0, sumY = 0;

            while (stack.length) {
                const cur = stack.pop();
                const cx = cur % w;
                const cy = (cur - cx) / w;

                area++;
                sumX += cx;
                sumY += cy;

                if (cx < minX) minX = cx;
                if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy;
                if (cy > maxY) maxY = cy;

                const neighbors = [
                    cur - 1, cur + 1, cur - w, cur + w
                ];

                for (const n of neighbors) {
                    if (n < 0 || n >= w * h) continue;

                    const nx = n % w;

                    // tránh wrap-around khi đi ngang qua mép trái/phải
                    if (Math.abs(nx - cx) > 1) continue;

                    if (!visited[n] && gray[n] < threshold) {
                        visited[n] = 1;
                        stack.push(n);
                    }
                }
            }

            blobs.push({
                area,
                minX, maxX, minY, maxY,
                cx: sumX / area,
                cy: sumY / area,
                width: maxX - minX + 1,
                height: maxY - minY + 1
            });
        }
    }

    return blobs;
}

function scoreAsMarker(blob, imgW, imgH) {
    const bboxArea = blob.width * blob.height;
    const fillRatio = blob.area / bboxArea;
    const aspect = blob.width / blob.height;
    const areaFrac = blob.area / (imgW * imgH);

    // Ô marker: đặc (fill cao), gần vuông, không quá nhỏ / quá to
    if (fillRatio < 0.55) return null;
    if (aspect < 0.5 || aspect > 2.0) return null;
    if (areaFrac < 0.00015 || areaFrac > 0.02) return null;

    // điểm số: ưu tiên fill cao + gần vuông
    const squareness = 1 - Math.abs(1 - aspect);

    return fillRatio * 0.5 + squareness * 0.5;
}

function pickCorner(blobs, imgW, imgH, cornerX, cornerY) {
    let best = null;
    let bestScore = -Infinity;

    for (const blob of blobs) {
        const markerScore = scoreAsMarker(blob, imgW, imgH);

        if (markerScore === null) continue;

        const dx = (blob.cx - cornerX) / imgW;
        const dy = (blob.cy - cornerY) / imgH;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Phạt khoảng cách tới góc tương ứng, nhưng vẫn ưu tiên điểm hình dạng
        const score = markerScore - distance * 0.8;

        if (score > bestScore) {
            bestScore = score;
            best = blob;
        }
    }

    return best;
}

/**
 * @param {string|Buffer} imagePathOrBuffer
 * @returns {Promise<{markers: object|null, missing: string[], scale: number, imageWidth:number, imageHeight:number}>}
 */
async function detectMarkers(imagePathOrBuffer) {
    const original = await Jimp.read(imagePathOrBuffer);

    const fullW = original.bitmap.width;
    const fullH = original.bitmap.height;

    const scale = Math.min(1, DOWNSCALE_WIDTH / fullW);

    const small = scale < 1
        ? original.clone().resize(Math.round(fullW * scale), Jimp.AUTO)
        : original.clone();

    const { gray, w, h } = buildGrayscaleBuffer(small);

    let bestSet = null;

    for (const threshold of THRESHOLDS) {
        const blobs = findDarkBlobs(gray, w, h, threshold);

        const corners = {
            top_left: pickCorner(blobs, w, h, 0, 0),
            top_right: pickCorner(blobs, w, h, w, 0),
            bottom_left: pickCorner(blobs, w, h, 0, h),
            bottom_right: pickCorner(blobs, w, h, w, h)
        };

        const foundCount = Object.values(corners).filter(Boolean).length;

        if (!bestSet || foundCount > bestSet.foundCount) {
            bestSet = { corners, foundCount, threshold };
        }

        if (foundCount === 4) break;
    }

    const missing = [];
    const markers = {};

    for (const key of ["top_left", "top_right", "bottom_left", "bottom_right"]) {
        const blob = bestSet.corners[key];

        if (!blob) {
            missing.push(key);
            continue;
        }

        markers[key] = {
            x: blob.cx / scale,
            y: blob.cy / scale
        };
    }

    return {
        markers: missing.length === 0 ? markers : null,
        missing,
        scale,
        imageWidth: fullW,
        imageHeight: fullH,
        thresholdUsed: bestSet.threshold
    };
}

module.exports = { detectMarkers };
