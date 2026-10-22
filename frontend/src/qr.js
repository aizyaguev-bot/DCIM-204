import QRCode from "qrcode";

// Square QR code for printed labels, generated locally (no network). Medium error correction survives
// smudges and small tears; the four-module white quiet zone that scanners need is part of the drawing.
export const QR_ERROR_CORRECTION = "M";
export const QR_QUIET_ZONE = 4;

// Returns one SVG path in module units: each run of dark modules in a row becomes one rectangle.
// The path holds only numbers and drawing commands, never the encoded text.
export function qrSvgPath(value, margin = QR_QUIET_ZONE) {
  const qr = QRCode.create(String(value), { errorCorrectionLevel: QR_ERROR_CORRECTION });
  const { size, data } = qr.modules;
  let path = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y * size + x]) continue;
      let run = 1;
      while (x + run < size && data[y * size + x + run]) run++;
      path += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return { size: size + margin * 2, modules: size, version: qr.version, path };
}
