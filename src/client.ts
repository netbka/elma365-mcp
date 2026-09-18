const TIMEOUT = 10_000;
const MAX_RETRIES = 3;

export function getDomain(): string {
  const domain = process.env.ELMA365_DOMAIN;
  if (!domain) throw new Error("ELMA365_DOMAIN не задан. Укажите домен (например: mycompany)");
  return domain;
}

export function getToken(): string {
  const token = process.env.ELMA365_TOKEN;
  if (!token) throw new Error("ELMA365_TOKEN не задан. Укажите Bearer-токен ELMA365 API");
  return token;
}

/** Resolve ELMA365_DOMAIN to a full origin, e.g. "mycompany" -> "https://mycompany.elma365.ru", or a self-hosted domain used as-is. */
export function getHostUrl(): string {
  const domain = getDomain();
  const host = domain.includes(".") ? domain : `${domain}.elma365.ru`;
  return `https://${host}`;
}

function getBaseUrl(): string {
  return `${getHostUrl()}/pub/v1`;
}

export function getExtensionsUrl(): string {
  const domain = getDomain();
  const host = domain.includes(".") ? domain : `${domain}.elma365.ru`;
  return `https://${host}/api/extensions`;
}

export async function elmaRequest(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  endpoint: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
): Promise<unknown> {
  const token = getToken();
  const baseUrl = getBaseUrl();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);

    const query = params ? `?${new URLSearchParams(params).toString()}` : "";

    try {
      const response = await fetch(`${baseUrl}/${endpoint}${query}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : { success: true };
      }

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        console.error(`[elma365-mcp] ${response.status}, повтор через ${delay}мс (${attempt}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const errBody = await response.text().catch(() => "");
      throw new Error(`ELMA365 HTTP ${response.status}: ${response.statusText}${errBody ? ` — ${errBody}` : ""}`);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof DOMException && error.name === "AbortError" && attempt < MAX_RETRIES) {
        console.error(`[elma365-mcp] Таймаут, повтор (${attempt}/${MAX_RETRIES})`);
        continue;
      }
      throw error;
    }
  }
  throw new Error("ELMA365 API: все попытки исчерпаны");
}
