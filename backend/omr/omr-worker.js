// Chạy đọc phiếu ở luồng nền để giao diện/camera không bị đơ.
importScripts("omr-core.js");

self.onmessage = function (e) {
    const { id, width, height, buffer } = e.data;

    try {
        const result = self.OMR.processImage({
            width,
            height,
            data: new Uint8ClampedArray(buffer)
        });

        const transfer = result.warped ? [result.warped.gray.buffer] : [];

        self.postMessage({ id, result }, transfer);
    } catch (error) {
        self.postMessage({ id, error: String((error && error.message) || error) });
    }
};
