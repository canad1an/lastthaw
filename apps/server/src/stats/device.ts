/**
 * What a browser's user-agent string says about the device, boiled down to a short key such as
 * "Safari · iOS · phone": enough to see what people play on, nothing that could identify anyone.
 */
export function deviceKey(ua: string | undefined | null): string {
  const s = (ua ?? "").slice(0, 400);
  if (!s) return "unknown";
  const has = (re: RegExp) => re.test(s);
  const form = has(/iPad|Tablet|(?:Android(?!.*Mobile))/i) ? "tablet" : has(/Mobi|iPhone|Android|IEMobile|Windows Phone/i) ? "phone" : "desktop";
  const os = has(/iPhone|iPad|iPod/i)
    ? "iOS"
    : has(/Android/i)
      ? "Android"
      : has(/Windows/i)
        ? "Windows"
        : has(/CrOS/i)
          ? "ChromeOS"
          : has(/Mac OS X|Macintosh/i)
            ? "macOS"
            : has(/Linux/i)
              ? "Linux"
              : "other OS";
  const browser = has(/Edg\//i)
    ? "Edge"
    : has(/OPR\/|Opera/i)
      ? "Opera"
      : has(/SamsungBrowser/i)
        ? "Samsung Internet"
        : has(/Firefox|FxiOS/i)
          ? "Firefox"
          : has(/CriOS/i)
            ? "Chrome"
            : has(/Chrome\//i)
              ? "Chrome"
              : has(/Safari\//i)
                ? "Safari"
                : "other browser";
  return `${browser} · ${os} · ${form}`;
}
