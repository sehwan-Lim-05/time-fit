const compact = value => String(value || '').replace(/\s+/g, ' ').trim();

export function normalizeOcrNumber(value) {
  const raw = compact(value).replace(/[₩￦원]/g, '').replace(/\s+/g, '');
  if (!raw || !/\d/.test(raw)) return null;
  const cleaned = raw.replace(/[^0-9.,-]/g, '');
  if (/^-?0[.,]\d+$/.test(cleaned)) return Number(cleaned.replace(',', '.'));
  if (/^-?\d+[.,]\d{1,2}$/.test(cleaned)) return Number(cleaned.replace(',', '.'));
  const integer = cleaned.replace(/[.,]/g, '');
  return /^-?\d+$/.test(integer) ? Number(integer) : null;
}

const verticesOf = box => (box?.vertices || box?.normalizedVertices || []).filter(vertex => Number.isFinite(vertex?.x) || Number.isFinite(vertex?.y));
const wordText = word => compact((word?.symbols || []).map(symbol => symbol.text || '').join(''));

export function visionWords(annotation = {}) {
  const result = [];
  for (const page of annotation.pages || []) for (const block of page.blocks || []) for (const paragraph of block.paragraphs || []) for (const word of paragraph.words || []) {
    const vertices = verticesOf(word.boundingBox);
    const xs = vertices.map(vertex => Number(vertex.x || 0)); const ys = vertices.map(vertex => Number(vertex.y || 0));
    const text = wordText(word); if (!text) continue;
    result.push({ text, x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function groupVisionLines(words = []) {
  const lines = [];
  for (const word of [...words].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const tolerance = Math.max(8, word.height * 0.7);
    let line = lines.find(candidate => Math.abs(candidate.y - word.y) <= Math.max(tolerance, candidate.height * 0.7));
    if (!line) { line = { y: word.y, height: word.height, words: [] }; lines.push(line); }
    line.words.push(word); line.y = line.words.reduce((sum, item) => sum + item.y, 0) / line.words.length; line.height = Math.max(line.height, word.height);
  }
  return lines.sort((a, b) => a.y - b.y).map(line => ({ ...line, words: line.words.sort((a, b) => a.x - b.x), text: line.words.sort((a, b) => a.x - b.x).map(word => word.text).join(' ') }));
}

const normalizedLabel = value => compact(value).replace(/\s+/g, '').replace(/[·:：]/g, '');
const businessNumbers = text => [...String(text || '').matchAll(/(\d{3})\s*-\s*(\d{2})\s*-\s*(\d{5})/g)].map(match => `${match[1]}-${match[2]}-${match[3]}`);
const amountTokens = words => {
  const joined = words.map(word => word.text).join('');
  const value = normalizeOcrNumber(joined);
  return Number.isFinite(value) ? value : null;
};

function findHeader(words, labels) {
  return words.find(word => labels.includes(normalizedLabel(word.text)));
}

function merchantFields(words, lines, text) {
  const pageRight = Math.max(1, ...words.map(word => word.right)); const midpoint = pageRight / 2;
  const leftText = words.filter(word => word.x < midpoint).map(word => word.text).join(' ');
  const rightText = words.filter(word => word.x >= midpoint).map(word => word.text).join(' ');
  const allNumbers = businessNumbers(text); const leftNumbers = businessNumbers(leftText); const rightNumbers = businessNumbers(rightText);
  const companyCandidates = words.filter(word => /^(?:주식회사|㈜|\(주\))/.test(word.text));
  const supplier = companyCandidates.find(word => word.x < midpoint);
  const recipient = companyCandidates.find(word => word.x >= midpoint);
  const companyName = (company, side) => {
    if (!company) return null;
    const candidates = words.filter(word => Math.abs(word.y - company.y) <= Math.max(30, company.height * 0.65) && !/\d{2,}/.test(word.text) && (side === 'left' ? word.x >= company.left && word.x < midpoint : word.x >= midpoint && word.x <= company.right + Math.max(500, company.width * 3))).sort((a, b) => a.x - b.x);
    const parts = candidates.map(word => word.text); const companyIndex = parts.findIndex(part => /^(?:주식회사|㈜|\(주\))/.test(part));
    if (companyIndex < 0) return company.text;
    return `${parts[companyIndex]}${parts.length > companyIndex + 1 ? ` ${parts.slice(companyIndex + 1).join('')}` : ''}`;
  };
  return {
    merchantName: companyName(supplier, 'left'),
    merchantBusinessNumber: leftNumbers[0] || allNumbers[0] || null,
    recipientName: companyName(recipient, 'right'),
    recipientBusinessNumber: rightNumbers[0] || allNumbers[1] || null,
  };
}

function dailySalesTotal(lines) {
  const words = lines.flatMap(line => line.words);
  const labelStart = words.find(word => /금일.*매출액/.test(word.text) || (/금일/.test(word.text) && words.some(candidate => /매출액/.test(candidate.text) && candidate.x > word.x && candidate.x - word.x < 500 && Math.abs(candidate.y - word.y) < 70)));
  if (labelStart) {
    const values = words.filter(word => word.x > labelStart.x && word.x - labelStart.x < 1100 && word.y >= labelStart.y - 5 && word.y - labelStart.y < 70 && /\d/.test(word.text)).sort((a, b) => a.x - b.x);
    const value = amountTokens(values); if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

const unitPattern = /^(?:kg|g|mg|l|ml|ea|box|개|통|봉|팩|박스|세트)$/i;
const numericWord = word => /\d/.test(word.text) && normalizeOcrNumber(word.text) !== null;

function lineItemsFromTable(words) {
  const itemHeader = findHeader(words, ['품명', '품명및', '규격']);
  const quantityHeader = findHeader(words, ['총수량', '수량']);
  const joinedHeader = (first, second) => {
    const left = words.find(word => normalizedLabel(word.text) === first && Math.abs(word.y - itemHeader?.y) < 60);
    const right = words.find(word => normalizedLabel(word.text) === second && left && word.x > left.x && word.x - left.x < 250 && Math.abs(word.y - left.y) < 30);
    return left && right ? { x: (left.x + right.x) / 2, left: left.left, right: right.right, y: (left.y + right.y) / 2, height: Math.max(left.height, right.height), width: right.right - left.left } : null;
  };
  const unitPriceHeader = findHeader(words, ['단가']) || joinedHeader('단', '가');
  const amountHeader = findHeader(words, ['금액']) || joinedHeader('금', '액');
  if (!itemHeader || !unitPriceHeader || !amountHeader) return [];
  const totalWord = words.find(word => word.y > itemHeader.y && /합계/.test(normalizedLabel(word.text)));
  const tableBottom = totalWord?.y || Math.max(...words.map(word => word.y));
  const nameRight = words.find(word => normalizedLabel(word.text) === 'BOX' && Math.abs(word.y - itemHeader.y) < 60)?.left || (quantityHeader ? quantityHeader.left * 0.75 : unitPriceHeader.left * 0.65);
  const quantityBoundary = quantityHeader ? (quantityHeader.x + unitPriceHeader.x) / 2 : unitPriceHeader.left;
  const priceBoundary = (unitPriceHeader.x + amountHeader.x) / 2;
  const rowLeft = Math.max(0, itemHeader.left * 0.6);
  const amountWords = words.filter(word => word.y > itemHeader.y + itemHeader.height && word.y < tableBottom && word.x >= priceBoundary && numericWord(word)).sort((a, b) => a.y - b.y);
  const rows = [];
  for (let index = 0; index < amountWords.length; index += 1) {
    const amountWord = amountWords[index];
    const previousY = index ? amountWords[index - 1].y : itemHeader.bottom; const nextY = index + 1 < amountWords.length ? amountWords[index + 1].y : tableBottom;
    const top = (previousY + amountWord.y) / 2; const bottom = (amountWord.y + nextY) / 2;
    const rowWords = words.filter(word => word.y >= top && word.y < bottom && word.x > rowLeft && word.x <= amountHeader.right + Math.max(120, amountHeader.width));
    const nameWords = rowWords.filter(word => word.x < nameRight).sort((a, b) => a.x - b.x);
    const unitIndex = nameWords.findLastIndex(word => unitPattern.test(normalizedLabel(word.text)));
    let unit = unitIndex >= 0 ? normalizedLabel(nameWords[unitIndex].text).toLowerCase() : null;
    const itemNameWords = nameWords.filter((_, wordIndex) => wordIndex !== unitIndex);
    let itemNameRaw = compact(itemNameWords.map(word => word.text).join('')).replace(/\s+/g, '');
    if (!unit) {
      const attachedUnit = itemNameRaw.match(/^(.+?)(kg|ea|box|개|통|봉|팩|박스|세트)$/i);
      if (attachedUnit) { itemNameRaw = attachedUnit[1]; unit = attachedUnit[2].toLowerCase(); }
    }
    const quantityValues = rowWords.filter(word => word.x >= nameRight && word.x < quantityBoundary && numericWord(word)).map(word => normalizeOcrNumber(word.text)).filter(value => Number.isFinite(value));
    const unitPrice = amountTokens(rowWords.filter(word => word.x >= quantityBoundary && word.x < priceBoundary && numericWord(word)));
    const lineAmount = normalizeOcrNumber(amountWord.text);
    const arithmeticQuantity = Number.isFinite(unitPrice) && Number.isFinite(lineAmount) && unitPrice > 0 ? lineAmount / unitPrice : null;
    const quantity = quantityValues.find(value => arithmeticQuantity !== null && Math.abs(value - arithmeticQuantity) < 0.0001) ?? quantityValues.at(-1) ?? arithmeticQuantity;
    if (!itemNameRaw || !Number.isFinite(lineAmount) || lineAmount <= 0) continue;
    const arithmeticValid = Number.isFinite(quantity) && Number.isFinite(unitPrice) && Math.abs(quantity * unitPrice - lineAmount) < 1;
    rows.push({ lineNumber: rows.length + 1, rawText: rowWords.map(word => word.text).join(' '), itemNameRaw, itemNameNormalized: itemNameRaw.toLowerCase().replace(/[^0-9a-z가-힣]+/gi, ' ').trim(), quantity: Number.isFinite(quantity) ? quantity : null, unit, unitPrice: Number.isFinite(unitPrice) ? Math.round(unitPrice) : null, discountAmount: 0, lineAmount: Math.round(lineAmount), taxType: 'unknown', confidence: arithmeticValid ? 0.96 : 0.68, arithmeticValid });
  }
  return rows;
}

export function extractSpatialReceipt(annotation = {}, text = '') {
  const words = visionWords(annotation); const lines = groupVisionLines(words);
  if (!words.length) return { lineItems: [] };
  return { ...merchantFields(words, lines, text), totalAmount: dailySalesTotal(lines), lineItems: lineItemsFromTable(words), spatialExtraction: true };
}
