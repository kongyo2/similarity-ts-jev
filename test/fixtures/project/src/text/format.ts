const escapedStringRegExp = /^'([^]*?)'?$/;
const doubleQuoteRegExp = /''/g;
const unescapedLatinCharacterRegExp = /[a-zA-Z]/;

export function format(date: Date, formatStr: string, options?: { locale?: string; weekStartsOn?: number }): string {
  const defaultOptions = { locale: "en-US", weekStartsOn: 0 };
  const locale = options?.locale ?? defaultOptions.locale;
  const weekStartsOn = options?.weekStartsOn ?? defaultOptions.weekStartsOn;
  if (weekStartsOn < 0 || weekStartsOn > 6) {
    throw new RangeError("weekStartsOn must be between 0 and 6 inclusively");
  }
  const parts = formatStr.match(/(\w)\1*|''|'(''|[^'])+('|$)|./g) ?? [];
  return parts
    .map((part) => {
      if (part === "''") return "'";
      if (part[0] === "'") return cleanEscapedString(part);
      if (unescapedLatinCharacterRegExp.test(part)) return renderToken(date, part, locale);
      return part;
    })
    .join("");
}

function renderToken(date: Date, token: string, locale: string): string {
  return token[0] === "y" ? String(date.getFullYear()) : date.toLocaleDateString(locale);
}

function cleanEscapedString(input: string): string {
  const matched = input.match(escapedStringRegExp);

  if (!matched) {
    return input;
  }

  return matched[1].replace(doubleQuoteRegExp, "'");
}
