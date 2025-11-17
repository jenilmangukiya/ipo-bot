import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    const API_URL = process.env.API_URL;
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;
    const REPORT_ID = process.env.API_REPORT_ID || "331";

    if (!API_URL || !BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ error: "Missing environment variables" });
    }

    function getFiscalYearLabel(date = new Date()) {
      const month = date.getMonth() + 1;
      const year = date.getFullYear();
      const fyStart = month >= 4 ? year : year - 1;
      const fyEnd = fyStart + 1;
      return `${fyStart}-${String(fyEnd).slice(-2)}`;
    }

    function buildCacheBuster(date = new Date()) {
      const day = String(date.getDate()).padStart(2, "0");
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      return `${day}-${hours}${minutes}`;
    }

    function buildApiUrl(now = new Date()) {
      const base = API_URL.trim().replace(/\/$/, ""); // remove trailing slash
      const reportId = REPORT_ID.trim();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const fiscal = getFiscalYearLabel(now);

      // construct path manually
      const path = `${base}/${reportId}/1/${month}/${year}/${fiscal}/0/ipo`;

      // attach query params manually
      const searchParams = new URLSearchParams({
        search: "",
        v: buildCacheBuster(now),
      });

      return `${path}?${searchParams.toString()}`;
    }

    async function fetchGmp() {
      const res = await fetch(buildApiUrl());
      if (!res.ok) throw new Error(`API error ${res.status}`);
      return res.json();
    }

    function decodeHtmlEntities(text) {
      if (typeof text !== "string") return "";
      const namedMap = {
        "&nbsp;": " ",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#39;": "'",
      };
      let decoded = text.replace(/&#(\d+);/g, (_, code) =>
        String.fromCodePoint(Number(code))
      );
      Object.entries(namedMap).forEach(([entity, char]) => {
        decoded = decoded.split(entity).join(char);
      });
      return decoded;
    }

    function getTodayIso(timeZone = "Asia/Kolkata") {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      return formatter.format(new Date());
    }

    const MONTH_SHORT = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };

    function normalizeDate(value) {
      if (!value || typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;

      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

      const shortMatch = trimmed.match(/^(\d{1,2})-([A-Za-z]{3})$/);
      if (shortMatch) {
        const day = shortMatch[1].padStart(2, "0");
        const month =
          MONTH_SHORT[shortMatch[2].toLowerCase()] ||
          MONTH_SHORT[shortMatch[2].slice(0, 3).toLowerCase()];
        if (month) {
          const year = new Date().getFullYear();
          return `${year}-${month}-${day}`;
        }
      }

      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) return null;
      return parsed.toISOString().slice(0, 10);
    }

    function stripHtml(text) {
      if (typeof text !== "string") return "";
      const withoutTags = text.replace(/<[^>]*>/g, " ");
      return decodeHtmlEntities(withoutTags).replace(/\s+/g, " ").trim();
    }

    function getCloseDateIso(row) {
      const normalised = row["~Srt_Close"] || row.Close;
      return normalizeDate(stripHtml(normalised));
    }

    function isClosingToday(row, todayIso = getTodayIso()) {
      return getCloseDateIso(row) === todayIso;
    }

    function formatIpoRow(row) {
      const name = stripHtml(row.Name) || "Unknown IPO";
      const gmp = stripHtml(row.GMP) || "-";
      const price = stripHtml(row.Price) || "-";
      const subs = stripHtml(row.Sub) || "-";
      const gmpRange = stripHtml(row["GMP(L/H)"]) || "-";
      const open = stripHtml(row.Open);
      const close = stripHtml(row.Close);
      const windowText =
        open || close ? `${open || "-"} – ${close || "-"}` : "-";
      const listing = stripHtml(row.Listing) || "-";
      const updated = stripHtml(row["Updated-On"]) || "-";

      return [
        `• ${name}`,
        `  GMP: ${gmp}`,
        `  Price: ${price}`,
        `  Subscriptions: ${subs}`,
        `  GMP Range: ${gmpRange}`,
        `  Window: ${windowText}`,
        `  Listing: ${listing}`,
        `  Updated: ${updated}`,
        `  Action: Apply today before the window closes ✅`,
      ].join("\n");
    }

    function formatMessage(data) {
      if (!data || !Array.isArray(data.reportTableData)) {
        return `📈 IPO GMP Update\n\n${JSON.stringify(data, null, 2)}`;
      }

      const todayIso = getTodayIso();
      const closingToday = data.reportTableData.filter((row) =>
        isClosingToday(row, todayIso)
      );

      const rows = closingToday.map(formatIpoRow).join("\n\n").trim();

      if (!rows) {
        return `📈 IPOs Closing Today (${todayIso})\n\nNo IPOs closing today.`;
      }

      return `📈 IPOs Closing Today (${todayIso})\n\n${rows}`;
    }

    async function sendTelegram(text) {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      });

      const json = await res.json();
      if (!json.ok)
        throw new Error(`Telegram send failed: ${JSON.stringify(json)} `);
      return json;
    }

    // MAIN LOGIC
    const data = await fetchGmp();
    console.log("data", data);
    const message = formatMessage(data);
    console.log("message", message);
    await sendTelegram(message);

    return res.status(200).json({ ok: true, sent: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
