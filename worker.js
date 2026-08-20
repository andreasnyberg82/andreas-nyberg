// Byte-range support for the Pomperipossa audio.
//
// Cloudflare's static asset server answers Range requests with a full 200,
// and iOS Safari treats that as "this server cannot stream media" and can
// refuse to play at all. This Worker sits in front of /pomperipossa/*.mp3
// only (see run_worker_first in wrangler.jsonc); every other path is served
// straight from assets, untouched.

function parseRange(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!match) return null; // absent, malformed, or multipart: caller serves the whole file

  const [, rawStart, rawEnd] = match;
  let start;
  let end;

  if (rawStart === "") {
    // suffix form: bytes=-500 means "the last 500 bytes"
    const suffix = Number(rawEnd);
    if (rawEnd === "" || !Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? total - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    end = Math.min(end, total - 1);
  }

  if (start >= total || start > end || start < 0) return { unsatisfiable: true };
  return { start, end };
}

export default {
  async fetch(request, env) {
    const asset = await env.ASSETS.fetch(request);
    if (!asset.ok) return asset;

    const body = await asset.arrayBuffer();
    const total = body.byteLength;
    const type = asset.headers.get("content-type") || "application/octet-stream";
    const isHead = request.method === "HEAD";

    const baseHeaders = {
      "content-type": type,
      "accept-ranges": "bytes",
      "cache-control": asset.headers.get("cache-control") || "public, max-age=3600",
    };

    const range = parseRange(request.headers.get("range"), total);

    if (range && range.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "content-range": `bytes */${total}` },
      });
    }

    if (!range) {
      return new Response(isHead ? null : body, {
        status: 200,
        headers: { ...baseHeaders, "content-length": String(total) },
      });
    }

    const { start, end } = range;
    const slice = body.slice(start, end + 1);

    return new Response(isHead ? null : slice, {
      status: 206,
      headers: {
        ...baseHeaders,
        "content-range": `bytes ${start}-${end}/${total}`,
        "content-length": String(slice.byteLength),
      },
    });
  },
};
