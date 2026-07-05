import puppeteer from "@cloudflare/puppeteer";

const TARGET_URL =
  "https://www.sfmatch.org/vacancies?sid=3ca047c8-4095-4e28-9aa1-20a7b0f404df&specialty=%5Bobject%20Object%5D";

const MAX_PAGES = 20;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function extractRows(page) {
  return await page.evaluate(() => {
    const clean = (s) =>
      (s || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const selectors = [
      ".MuiDataGrid-row",
      "[role='row']",
      "table tbody tr",
      "table tr"
    ];

    const rowNodes = [...document.querySelectorAll(selectors.join(","))];

    const rows = rowNodes
      .map((row) => {
        const cells = [
          ...row.querySelectorAll(
            ".MuiDataGrid-cell, [role='cell'], [role='columnheader'], td, th"
          )
        ]
          .map((cell) => clean(cell.innerText || cell.textContent))
          .filter(Boolean);

        return {
          cells,
          text: cells.join("\t")
        };
      })
      .filter((r) => r.cells.length > 0 && r.text.length > 0);

    const unique = [];
    const seen = new Set();

    for (const row of rows) {
      if (!seen.has(row.text)) {
        seen.add(row.text);
        unique.push(row);
      }
    }

    return {
      title: document.title,
      url: location.href,
      bodyText: clean(document.body.innerText || "").slice(0, 20000),
      rows: unique
    };
  });
}

async function clickNext(page) {
  return await page.evaluate(() => {
    const clean = (s) =>
      (s || "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const candidates = [
      ...document.querySelectorAll("button, [role='button'], a")
    ];

    const next = candidates.find((el) => {
      const text = clean(el.innerText || el.textContent);
      const aria = clean(el.getAttribute("aria-label"));
      const title = clean(el.getAttribute("title"));

      const disabled =
        el.disabled ||
        el.getAttribute("aria-disabled") === "true" ||
        el.classList.contains("Mui-disabled") ||
        el.classList.contains("disabled");

      const looksNext =
        text === "next" ||
        text === ">" ||
        text === "›" ||
        aria.includes("next") ||
        aria.includes("go to next page") ||
        title.includes("next");

      return looksNext && !disabled;
    });

    if (!next) return false;

    next.click();
    return true;
  });
}

function rowsToText(result) {
  const lines = [];

  lines.push(`Extracted at: ${result.extractedAt}`);
  lines.push(`Target: ${result.targetUrl}`);
  lines.push(`Pages checked: ${result.pagesChecked}`);
  lines.push(`Rows found: ${result.totalRows}`);
  lines.push("");

  for (const page of result.pages) {
    lines.push(`--- PAGE ${page.pageNumber} ---`);
    for (const row of page.rows) {
      lines.push(row.text);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/health") {
      return textResponse("ok");
    }

    if (env.ACCESS_TOKEN) {
      const supplied = requestUrl.searchParams.get("token");
      if (supplied !== env.ACCESS_TOKEN) {
        return jsonResponse(
          {
            error: "Unauthorized",
            hint: "Add ?token=YOUR_ACCESS_TOKEN to the URL."
          },
          401
        );
      }
    }

    const targetUrl = requestUrl.searchParams.get("url") || TARGET_URL;
    const format = requestUrl.searchParams.get("format") || "json";

    let browser;

    try {
      browser = await puppeteer.launch(env.MYBROWSER);

      const page = await browser.newPage();

      await page.setViewport({
        width: 1440,
        height: 1800,
        deviceScaleFactor: 1
      });

      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
      );

      await page.goto(targetUrl, {
        waitUntil: "networkidle2",
        timeout: 45000
      });

      await wait(3500);

      const pages = [];
      const seenFingerprints = new Set();

      for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
        await wait(1000);

        const snapshot = await extractRows(page);
        const fingerprint = snapshot.rows.map((r) => r.text).join("|");

        if (seenFingerprints.has(fingerprint)) {
          break;
        }

        seenFingerprints.add(fingerprint);

        pages.push({
          pageNumber,
          url: snapshot.url,
          title: snapshot.title,
          rows: snapshot.rows,
          diagnosticBodyText:
            snapshot.rows.length === 0 ? snapshot.bodyText : undefined
        });

        const didClickNext = await clickNext(page);

        if (!didClickNext) {
          break;
        }

        await wait(2200);
      }

      const allRows = pages.flatMap((p) =>
        p.rows.map((row) => ({
          page: p.pageNumber,
          cells: row.cells,
          text: row.text
        }))
      );

      const result = {
        source: "SF Match Vacancies",
        extractedAt: new Date().toISOString(),
        targetUrl,
        pagesChecked: pages.length,
        totalRows: allRows.length,
        allRows,
        pages
      };

      if (format === "text") {
        return textResponse(rowsToText(result));
      }

      return jsonResponse(result);
    } catch (error) {
      return jsonResponse(
        {
          error: String(error?.message || error),
          note: "If this is a 429, the Cloudflare Browser Run free daily limit may have been reached."
        },
        500
      );
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
};
