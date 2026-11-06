// URL matching for page.waitForURL, ported from Playwright's packages/isomorphic/urlMatch.ts
// (Copyright (c) Microsoft Corporation, Apache License 2.0) so that globs, regular expressions and
// predicates written for Playwright match the same URLs here. OmOWright has no baseURL option, so
// globs resolve the way Playwright resolves them without one.

const escapedChars = new Set(["$", "^", "+", ".", "*", "(", ")", "|", "\\", "?", "{", "}", "[", "]"]);

function globToRegexPattern(glob) {
  const tokens = ["^"];
  let inGroup = false;
  for (let i = 0; i < glob.length; ++i) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) {
      const char = glob[++i];
      tokens.push(escapedChars.has(char) ? "\\" + char : char);
      continue;
    }
    if (c === "*") {
      const charBefore = glob[i - 1];
      let starCount = 1;
      while (glob[i + 1] === "*") {
        starCount++;
        i++;
      }
      if (starCount > 1) {
        const charAfter = glob[i + 1];
        // Match either /..something../ or /.
        if (charAfter === "/") {
          if (charBefore === "/") tokens.push("((.+/)|)");
          else tokens.push("(.*/)");
          ++i;
        } else {
          tokens.push("(.*)");
        }
      } else {
        tokens.push("([^/]*)");
      }
      continue;
    }

    switch (c) {
      case "{":
        if (inGroup) throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: nested '{' is not supported`);
        inGroup = true;
        tokens.push("(");
        break;
      case "}":
        if (!inGroup) throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '}'`);
        inGroup = false;
        tokens.push(")");
        break;
      case ",":
        if (inGroup) {
          tokens.push("|");
          break;
        }
        tokens.push("\\" + c);
        break;
      default:
        tokens.push(escapedChars.has(c) ? "\\" + c : c);
    }
  }
  if (inGroup) throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '{'`);
  tokens.push("$");
  return tokens.join("");
}

function resolveGlob(match) {
  if (match.startsWith("*")) return match;
  const tokenMap = new Map();
  function mapToken(original, replacement) {
    if (original.length === 0) return "";
    tokenMap.set(replacement, original);
    return replacement;
  }
  // Escaped `\\?` behaves the same as `?` in these glob patterns.
  match = match.replaceAll(/\\\\\?/g, "?");
  if (match.startsWith("about:") || match.startsWith("data:")
    || match.startsWith("chrome:") || match.startsWith("edge:")
    || match.startsWith("file:")) return match;
  // Glob symbols may be escaped in the URL and some of them such as ? affect resolution,
  // so they are replaced with safe components first.
  const relativePath = match.split("/").map((token, index) => {
    if (token === "." || token === ".." || token === "") return token;
    // http*:// and similar: the stand-in scheme must be a web scheme so slashes follow the host.
    if (index === 0 && token.endsWith(":")) {
      if (token.indexOf("*") !== -1 || token.indexOf("{") !== -1) return mapToken(token, "http:");
      // An explicit scheme is kept as is; it decides trailing slashes after the host.
      return token;
    }
    // Literal components round-trip through new URL() so default ports, percent-encoding and IDN
    // hosts are normalized; only components with glob characters are replaced.
    if (!/[*?{}\\]/.test(token)) return token;
    const questionIndex = token.indexOf("?");
    if (questionIndex === -1) return mapToken(token, `$_${index}_$`);
    const newPrefix = mapToken(token.substring(0, questionIndex), `$_${index}_$`);
    const newSuffix = mapToken(token.substring(questionIndex), `?$_${index}_$`);
    return newPrefix + newSuffix;
  }).join("/");
  const result = resolveURL(relativePath);
  let resolved = result.resolved;
  for (const [token, original] of tokenMap) {
    const normalize = result.caseInsensitivePart?.includes(token);
    const replacement = normalize ? original.toLowerCase() : original;
    // The function form keeps `$$`, `$&` and similar replacement patterns literal.
    resolved = resolved.replace(token, () => replacement);
  }
  return resolved;
}

function resolveURL(givenURL) {
  try {
    const url = new URL(givenURL);
    // Scheme and host are case-insensitive.
    return { resolved: url.toString(), caseInsensitivePart: url.origin };
  } catch {
    return { resolved: givenURL };
  }
}

function parseURL(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isRegExp(value) {
  return value instanceof RegExp || Object.prototype.toString.call(value) === "[object RegExp]";
}

/**
 * Playwright's URL match: a glob string, a RegExp, or a predicate receiving a URL object.
 * An empty or missing match accepts every URL; an invalid glob throws.
 */
export async function urlMatches(urlString, match) {
  if (match === undefined || match === "") return true;
  if (typeof match === "string") match = new RegExp(globToRegexPattern(resolveGlob(match)));
  if (isRegExp(match)) {
    match.lastIndex = 0;
    return match.test(urlString);
  }
  if (typeof match !== "function") throw new TypeError("url parameter should be string, RegExp or function");
  const url = parseURL(urlString);
  if (!url) return false;
  return Boolean(await match(url));
}
