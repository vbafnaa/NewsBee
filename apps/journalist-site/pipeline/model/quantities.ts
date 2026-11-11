/** Equivalent numeric spellings share a value; currencies and percentages remain distinct. */
export function quantities(text: string) {
  return [...text.matchAll(/([$£€]\s*)?(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*(thousand\b|million\b|billion\b|percent\b|%))?/gi)].map(match => {
    const magnitude = ({ thousand: 1e3, million: 1e6, billion: 1e9 } as Record<string, number>)[match[3]?.toLowerCase()] ?? 1;
    const value = Number(match[2].replace(/,/g, '')) * magnitude;
    const unit = match[1]?.trim() ?? (/^(?:percent|%)$/i.test(match[3] ?? '') ? '%' : '');
    return { value: String(value), key: `${unit}${value}`, display: match[0].toLowerCase().replace(/,/g, '').replace(/\s+/g, '').replace(/percent$/, '%').replace(/\d+(?:\.\d+)?/, number => String(Number(number))) };
  });
}
