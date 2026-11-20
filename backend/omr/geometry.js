/**
 * Các hàm hình học thuần JS dùng cho OMR:
 * - Giải phép biến đổi phối cảnh (homography) từ 4 cặp điểm tương ứng.
 * - "Duỗi thẳng" (warp) một vùng ảnh chụp nghiêng về mặt phẳng chuẩn.
 *
 * Không phụ thuộc OpenCV/native binding — chỉ cần `jimp`, phù hợp để
 * cài đặt trên Render (không cần build native module).
 */

// Giải hệ phương trình tuyến tính A·x = b bằng khử Gauss (Gauss-Jordan).
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

/**
 * Tính ma trận homography H (3x3, h33=1) sao cho với mỗi cặp điểm
 * (src_i -> dst_i): dst = H * src (tọa độ thuần nhất).
 *
 * Trả về mảng 8 số [h11,h12,h13,h21,h22,h23,h31,h32] (h33 = 1).
 */
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

function applyHomography(H, x, y) {
    const w = H.h31 * x + H.h32 * y + H.h33;

    return {
        x: (H.h11 * x + H.h12 * y + H.h13) / w,
        y: (H.h21 * x + H.h22 * y + H.h23) / w
    };
}

/**
 * Lấy màu điểm ảnh bằng nội suy song tuyến (bilinear) từ bitmap Jimp.
 * Trả về độ sáng (0 = đen tuyệt đối, 255 = trắng tuyệt đối) đã quy về grayscale.
 */
function sampleGray(image, x, y) {
    const w = image.bitmap.width;
    const h = image.bitmap.height;

    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) {
        return 255; // ngoài ảnh -> coi như nền trắng
    }

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);

    const fx = x - x0;
    const fy = y - y0;

    const g = (px, py) => {
        const idx = image.getPixelIndex(px, py);
        const { data } = image.bitmap;

        // grayscale theo trọng số chuẩn (ITU-R BT.601)
        return (
            data[idx] * 0.299 +
            data[idx + 1] * 0.587 +
            data[idx + 2] * 0.114
        );
    };

    const top = g(x0, y0) * (1 - fx) + g(x1, y0) * fx;
    const bottom = g(x0, y1) * (1 - fx) + g(x1, y1) * fx;

    return top * (1 - fy) + bottom * fy;
}

/**
 * Duỗi thẳng (warp) ảnh chụp về một mặt phẳng REF_W x REF_H, dựa trên
 * homography ánh xạ từ hệ tọa độ tham chiếu (template) sang ảnh gốc.
 *
 * Trả về một Jimp image mới có kích thước outW x outH.
 */
async function warpToReference(Jimp, sourceImage, H, outW, outH) {
    const output = new Jimp(outW, outH, 0xffffffff);

    for (let ty = 0; ty < outH; ty++) {
        for (let tx = 0; tx < outW; tx++) {
            const { x: sx, y: sy } = applyHomography(H, tx, ty);

            const gray = Math.round(sampleGray(sourceImage, sx, sy));
            const clamped = Math.max(0, Math.min(255, gray));

            output.setPixelColor(
                Jimp.rgbaToInt(clamped, clamped, clamped, 255),
                tx,
                ty
            );
        }
    }

    return output;
}

module.exports = {
    computeHomography,
    applyHomography,
    sampleGray,
    warpToReference
};
