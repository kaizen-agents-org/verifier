export function slugify(text) {
  let result = "";
  for (const char of text.toLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      result += char;
    } else if (result.length > 0 && result[result.length - 1] !== "-") {
      result += "-";
    }
  }
  return result.replace(/-+$/, "");
}
