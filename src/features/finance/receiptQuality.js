export function analyzeReceiptPixels({ width, height, pixels, sampleWidth = width, sampleHeight = height }) {
  const issues = [];
  if (Math.min(width, height) < 800) issues.push({ code: 'low_resolution', message: '사진 해상도가 낮아요. 영수증에 더 가까이 촬영해 주세요.' });
  if (!pixels?.length) return issues;
  let brightness = 0; let gradients = 0; let comparisons = 0;
  const luminance = [];
  for (let index = 0; index < pixels.length; index += 4) {
    const value = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
    luminance.push(value); brightness += value;
  }
  brightness /= luminance.length;
  for (let y = 1; y < sampleHeight; y += 1) for (let x = 1; x < sampleWidth; x += 1) {
    const index = y * sampleWidth + x; gradients += Math.abs(luminance[index] - luminance[index - 1]) + Math.abs(luminance[index] - luminance[index - sampleWidth]); comparisons += 2;
  }
  const sharpness = comparisons ? gradients / comparisons : 0;
  if (brightness < 45) issues.push({ code: 'too_dark', message: '사진이 너무 어두워요. 밝은 곳에서 다시 촬영해 주세요.' });
  if (brightness > 242) issues.push({ code: 'too_bright', message: '빛 반사가 강해요. 플래시를 끄거나 각도를 바꿔 주세요.' });
  if (sharpness < 3.2) issues.push({ code: 'blurred', message: '글자가 흐릴 수 있어요. 초점을 맞추고 흔들리지 않게 촬영해 주세요.' });
  return issues;
}

export async function inspectReceiptImage(file) {
  if (!file?.type?.startsWith('image/') || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return [];
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)); const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return [];
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    return analyzeReceiptPixels({ width: bitmap.width, height: bitmap.height, pixels, sampleWidth: width, sampleHeight: height });
  } catch { return []; }
  finally { bitmap?.close?.(); }
}

export const RECEIPT_OCR_MAX_BYTES = 7 * 1024 * 1024;
const RECEIPT_MAX_DIMENSION = 2600;
const RECEIPT_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const isHeic = file => ['image/heic', 'image/heif'].includes(String(file?.type || '').toLowerCase()) || /\.hei[cf]$/i.test(file?.name || '');

const canvasBlob = (canvas, quality) => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('영수증 이미지를 변환하지 못했습니다.')), 'image/jpeg', quality));

async function heicToBlob(file) {
  const module = await import('heic2any');
  const converted = await module.default({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(converted) ? converted[0] : converted;
}

async function optimizeReceiptImage(file) {
  if (!RECEIPT_INPUT_TYPES.has(String(file?.type || '').toLowerCase()) && !isHeic(file)) throw new Error('JPG, PNG, WebP 또는 HEIC 이미지만 올릴 수 있어요.');
  if (!isHeic(file) && file.size <= RECEIPT_OCR_MAX_BYTES) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new Error('큰 영수증 이미지 변환을 지원하지 않는 브라우저입니다. 사진 크기를 줄이거나 최신 브라우저에서 다시 시도해 주세요.');
  const source = isHeic(file) ? await heicToBlob(file) : file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(source);
    const scale = Math.min(1, RECEIPT_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('영수증 이미지 변환을 지원하지 않는 브라우저입니다.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob;
    for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58]) {
      blob = await canvasBlob(canvas, quality);
      if (blob.size <= RECEIPT_OCR_MAX_BYTES) break;
    }
    if (!blob || blob.size > RECEIPT_OCR_MAX_BYTES) throw new Error('이미지 용량을 줄이지 못했습니다. 사진을 나누거나 해상도를 낮춰 주세요.');
    return new File([blob], String(file.name || 'receipt').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
  } catch (error) {
    if (isHeic(file)) throw new Error('HEIC 사진을 변환하지 못했습니다. 기기에서 JPG로 저장한 뒤 다시 선택해 주세요.');
    throw error;
  } finally { bitmap?.close?.(); }
}

export async function prepareReceiptFiles(files) {
  const selected = Array.from(files || []).filter(Boolean).slice(0, 20);
  if (!selected.length) return [];
  const prepared = [];
  for (const file of selected) prepared.push(await optimizeReceiptImage(file));
  if (prepared.reduce((sum, file) => sum + file.size, 0) > 60 * 1024 * 1024) throw new Error('영수증 전체 용량은 60MB 이하만 올릴 수 있어요.');
  return prepared;
}
