// Free relay for the lottery feed, for hosts the feed refuses with a 403.
//
// Why: draw.ar-lottery01.com answers some data-centre IPs with a flat 403 before it
// even looks at the request (Render's outbound IP is one of them). The same request
// from a normal connection returns 200. A relay puts a different IP in front.
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create Worker → paste this →
// Deploy. Then in Render set:
//     FEED_PROXY = https://<your-worker>.workers.dev/?url=
// The engine appends the encoded feed URL after that.

const ALLOWED_HOST = "ar-lottery01.com";

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("usage: ?url=<feed url>", { status: 400 });
    }

    let parsed;
    try { parsed = new URL(target); }
    catch { return new Response("bad url", { status: 400 }); }

    // Only ever relay the feed this worker exists for.
    if (!parsed.hostname.endsWith(ALLOWED_HOST)) {
      return new Response("host not allowed", { status: 403 });
    }

    try {
      const res = await fetch(parsed.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://draw.ar-lottery01.com/"
        },
        cf: { cacheTtl: 0 }
      });
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
