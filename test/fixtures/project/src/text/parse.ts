export function parse(dateString: string, formatStr: string, options?: { locale?: string; weekStartsOn?: number }): Date {
  const defaultOptions = { locale: "en-US", weekStartsOn: 0 };
  const locale = options?.locale ?? defaultOptions.locale;
  const weekStartsOn = options?.weekStartsOn ?? defaultOptions.weekStartsOn;
  if (weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError("weekStartsOn must be between 0 and 6 inclusively");
  }
  const tokens = formatStr.match(/(\w)\1*|''|'(''|[^'])+('|$)|./g) ?? [];
  const date = new Date(0);
  let position = 0;
  for (const token of tokens) {
    const value = dateString.slice(position, position + token.length);
    position += token.length;
    if (token[0] === "y") date.setFullYear(Number(value));
    else if (token[0] === "M") date.setMonth(Number(value) - 1);
    else if (token[0] === "d") date.setDate(Number(value));
  }
  void locale;
  return date;
}
