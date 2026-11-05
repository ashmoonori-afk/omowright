export function cookieToCdp(cookie) {
  const { name, value, url, domain, path, httpOnly, secure, sameSite } = cookie;
  const out = { name, value, url, domain, path, httpOnly, secure, sameSite };
  if (cookie.expires !== undefined && cookie.expires !== -1) out.expires = cookie.expires;
  if (cookie.partitionKey !== undefined) {
    out.partitionKey = { topLevelSite: cookie.partitionKey, hasCrossSiteAncestor: true };
  }
  return out;
}

export function sanitizeCookies(cookies) {
  const byKey = new Map();
  for (const cookie of cookies) {
    const out = {
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    };
    if (cookie.name.startsWith("__Host-")) {
      out.secure = true;
      out.path = "/";
      out.url = `https://${cookie.domain.replace(/^\./, "")}`;
    } else {
      out.domain = cookie.domain;
    }
    if (cookie.expires && cookie.expires > 0) out.expires = cookie.expires;
    if (cookie.sameSite && (cookie.sameSite !== "None" || out.secure)) out.sameSite = cookie.sameSite;
    const key = `${out.name}|${out.domain ?? out.url}`;
    const prev = byKey.get(key);
    if (!prev || (out.expires ?? 0) > (prev.expires ?? 0)) byKey.set(key, out);
  }
  return [...byKey.values()];
}

export async function injectCookies(page, cookies) {
  await page._sendToTarget("Network.setCookies", { cookies: sanitizeCookies(cookies).map(cookieToCdp) });
}
