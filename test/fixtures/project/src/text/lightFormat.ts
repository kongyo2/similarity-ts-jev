const escapedStringRegExp = /^'([^]*?)'?$/;
const doubleQuoteRegExp = /''/g;
const unescapedLatinCharacterRegExp = /[a-zA-Z]/;

export function lightFormat(date: Date, formatStr: string): string {
  const parts = formatStr.match(/(\w)\1*|''|'(''|[^'])+('|$)|./g) ?? [];
  return parts
    .map((part) => {
      if (part === "''") return "'";
      if (part[0] === "'") return cleanEscapedString(part);
      if (unescapedLatinCharacterRegExp.test(part)) return String(date.getFullYear());
      return part;
    })
    .join("");
}

function cleanEscapedString(input: string): string {
  const matched = input.match(escapedStringRegExp);

  if (!matched) {
    return input;
  }

  return matched[1].replace(doubleQuoteRegExp, "'");
}
