// ==UserScript==
// @name         SDx Bluebeam Review
// @namespace    https://github.com/JGtz-BMcD/SDx_Bluebeam_Review
// @author       JGtz-BMcD
// @homepageURL  https://github.com/JGtz-BMcD/SDx_Bluebeam_Review
// @supportURL   https://github.com/JGtz-BMcD/SDx_Bluebeam_Review/issues
// @downloadURL  https://raw.githubusercontent.com/JGtz-BMcD/SDx_Bluebeam_Review/main/SDx-Bluebeam-Review.user.js
// @updateURL    https://raw.githubusercontent.com/JGtz-BMcD/SDx_Bluebeam_Review/main/SDx-Bluebeam-Review.user.js
// @version      1.0.0
// @description  Import markups made in Bluebeam Revu (standard PDF annotations, incl. snapshots/stamps) into your own SDx markup layer on the document you are viewing, with author/date/subject metadata tracked. Drag and drop the PDF into the popup, or use Export to Bluebeam to copy the SDx PDF to a working folder and import it back after saving.
// @match        https://*/enr01/*
// @match        https://*/ENR01/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
// @require      https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.js
// @grant        none
// ==/UserScript==
(function () {
    "use strict";
    const VERSION = "1.0.0";
    const TOOL = "Bluebeam Review";
    const ICON = "\u{1F4D0}";
    const IDS = { style: "sdxbm_style", btn: "sdxbm_btn", modal: "sdxbm_modal", backdrop: "sdxbm_backdrop" };
    const AUTH_KEY = "sdxbm_auth_v01";
    const DEFAULT_API_BASE = "/ENR01Server/api/v2";

    // ==CONVERTER-BEGIN==
    /************************************************************
     * PDF annotation (plain JS object) -> XFDF element string
     * Pure functions: no DOM, no network.
     ************************************************************/
    const SUPPORTED = new Set([
        "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Ink",
        "Highlight", "Underline", "StrikeOut", "Squiggly", "Text", "Stamp"
    ]);
    const FLAG_NAMES = [[1, "invisible"], [2, "hidden"], [4, "print"], [8, "nozoom"], [16, "norotate"], [32, "noview"], [64, "readonly"], [128, "locked"]];

    function xmlEsc(s) {
        return String(s)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function num(n) {
        const v = Number(n);
        return Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : "0";
    }
    function numList(arr, sep) {
        return (arr || []).map(num).join(sep || ",");
    }
    function hex2(v) {
        return Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0").toUpperCase();
    }
    function colorHex(c) {
        if (!Array.isArray(c) || !c.length) return null;
        let r, g, b;
        if (c.length === 1) { r = g = b = c[0]; }
        else if (c.length === 3) { [r, g, b] = c; }
        else if (c.length === 4) {
            const [cy, m, y, k] = c;
            r = (1 - cy) * (1 - k); g = (1 - m) * (1 - k); b = (1 - y) * (1 - k);
        } else return null;
        return "#" + hex2(r) + hex2(g) + hex2(b);
    }
    function normRect(r) {
        if (!Array.isArray(r) || r.length < 4) return null;
        return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    }
    function flagsString(f) {
        const v = Number(f) || 0;
        return FLAG_NAMES.filter(([bit]) => v & bit).map(([, name]) => name).join(",");
    }
    function parseDA(da) {
        const out = { color: null, size: null, da: da || "" };
        if (!da) return out;
        let m = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
        if (m) out.color = colorHex([+m[1], +m[2], +m[3]]);
        else if ((m = da.match(/([\d.]+)\s+g\b/))) out.color = colorHex([+m[1]]);
        m = da.match(/\/(\S+)\s+([\d.]+)\s+Tf/);
        if (m) out.size = +m[2];
        out.da = da.replace(/\/Helv\b/, "/Helvetica");
        return out;
    }
    function attrs(obj) {
        return Object.entries(obj)
            .filter(([, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => `${k}="${xmlEsc(v)}"`)
            .join(" ");
    }
    function lineEnding(le, i) {
        const v = Array.isArray(le) ? le[i] : (i === 0 ? le : null);
        return v || "None";
    }

    // opts: { page, author, markupOBID, name, parentName, importedAt }
    function annotToXfdf(a, opts) {
        const type = a.Subtype;
        if (!SUPPORTED.has(type)) return { skip: `${type || "unknown"} not supported` };
        const rect = normRect(a.Rect);
        if (!rect) return { skip: "no rectangle" };
        const border = a.BS || {};
        let width = border.W;
        if (width === undefined && Array.isArray(a.Border)) width = a.Border[2];
        const da = parseDA(a.DA);
        const common = {
            page: opts.page,
            rect: numList(rect),
            color: colorHex(a.C),
            flags: flagsString(a.F),
            name: opts.name,
            title: opts.author,
            subject: a.Subj,
            date: a.M || a.CreationDate,
            creationdate: a.CreationDate || a.M,
            opacity: a.CA !== undefined && a.CA !== 1 ? num(a.CA) : null,
            width: width !== undefined ? num(width) : null,
            "interior-color": colorHex(a.IC),
            IT: a.IT,
            inreplyto: opts.parentName,
            replytype: opts.parentName ? (a.RT === "Group" ? "Group" : "R") : null
        };
        if (border.S === "D" && Array.isArray(border.D)) {
            common.style = "dash";
            common.dashes = numList(border.D);
        }
        if (a.BE && a.BE.S === "C") {
            common.style = "cloudy";
            common.intensity = num(a.BE.I || 2);
        }
        if (Array.isArray(a.RD) && a.RD.length === 4 && type !== "FreeText") {
            common.fringe = numList(a.RD);
        }
        const custom = {
            ID: opts.markupOBID,
            bbAuthor: a.T || "",
            bbName: a.NM || "",
            bbSubject: a.Subj || "",
            bbImportedAt: opts.importedAt
        };
        const contents = a.Contents ? `<contents>${xmlEsc(a.Contents)}</contents>` : "";
        let tag = type.toLowerCase();
        let extra = {};
        let body = "";
        switch (type) {
            case "FreeText": {
                tag = "freetext";
                extra = {
                    rotation: a.Rotate ? num(a.Rotate) : null,
                    fringe: Array.isArray(a.RD) && a.RD.length === 4 ? numList(a.RD) : null,
                    TextColor: da.color,
                    FontSize: da.size !== null ? num(da.size) : null,
                    callout: Array.isArray(a.CL) && a.CL.length >= 4 ? numList(a.CL) : null,
                    head: a.CL ? lineEnding(a.LE, 0) : null
                };
                body = `${contents}${da.da ? `<defaultappearance>${xmlEsc(da.da)}</defaultappearance>` : ""}${a.DS ? `<defaultstyle>${xmlEsc(a.DS)}</defaultstyle>` : ""}`;
                break;
            }
            case "Line": {
                if (!Array.isArray(a.L) || a.L.length < 4) return { skip: "line without coordinates" };
                extra = {
                    start: numList(a.L.slice(0, 2)),
                    end: numList(a.L.slice(2, 4)),
                    head: lineEnding(a.LE, 0),
                    tail: lineEnding(a.LE, 1)
                };
                body = contents;
                break;
            }
            case "Square":
            case "Circle":
                tag = type === "Square" ? "square" : "circle";
                body = contents;
                break;
            case "Polygon":
            case "PolyLine": {
                if (!Array.isArray(a.Vertices) || a.Vertices.length < 4) return { skip: "no vertices" };
                tag = type === "Polygon" ? "polygon" : "polyline";
                const pts = [];
                for (let i = 0; i + 1 < a.Vertices.length; i += 2) pts.push(num(a.Vertices[i]) + "," + num(a.Vertices[i + 1]));
                if (tag === "polyline") {
                    extra = { head: lineEnding(a.LE, 0), tail: lineEnding(a.LE, 1) };
                }
                body = `${contents}<vertices>${pts.join(";")}</vertices>`;
                break;
            }
            case "Ink": {
                if (!Array.isArray(a.InkList) || !a.InkList.length) return { skip: "ink without strokes" };
                tag = "ink";
                const gestures = a.InkList.map(stroke => {
                    const pts = [];
                    for (let i = 0; i + 1 < stroke.length; i += 2) pts.push(num(stroke[i]) + "," + num(stroke[i + 1]));
                    return `<gesture>${pts.join(";")}</gesture>`;
                }).join("");
                body = `${contents}<inklist>${gestures}</inklist>`;
                break;
            }
            case "Highlight":
            case "Underline":
            case "StrikeOut":
            case "Squiggly": {
                if (!Array.isArray(a.QuadPoints) || a.QuadPoints.length < 8) return { skip: "text markup without quads" };
                tag = type === "StrikeOut" ? "strikeout" : type.toLowerCase();
                extra = { coords: numList(a.QuadPoints) };
                body = contents;
                break;
            }
            case "Stamp": {
                // Snapshots and image/vector stamps: the caller renders the
                // appearance stream to a PNG data URL and passes it in.
                if (!opts.imageData) return { skip: "stamp image could not be rendered" };
                tag = "stamp";
                custom["trn-annot-maintain-aspect-ratio"] = "true";
                custom["trn-unrotated-rect"] = numList(rect);
                extra = { rotation: "0", icon: "Snapshot", IT: null, color: null, width: null };
                if (typeof opts.stampOpacity === "number" && opts.stampOpacity < 1) common.opacity = num(opts.stampOpacity);
                else common.opacity = null;
                body = `${contents}<imagedata>${opts.imageData}</imagedata>`;
                break;
            }
            case "Text": {
                tag = "text";
                extra = {
                    icon: a.Name || "Note",
                    state: a.State || null,
                    statemodel: a.StateModel || null
                };
                body = contents;
                break;
            }
        }
        const customXml = `<trn-custom-data bytes="${xmlEsc(JSON.stringify(custom))}"/>`;
        const xml = `<${tag} ${attrs({ ...common, ...extra })}>${customXml}${body}</${tag}>`;
        return { xml, tag };
    }

    // Walks a list of { page, index, a, parentNM } and returns XFDF fragments.
    function convertAll(items, ctx) {
        const out = [];
        const skipped = [];
        const importedAt = ctx.importedAt || new Date().toISOString();
        for (const it of items) {
            const a = it.a;
            const nm = a.NM || `p${it.page}_${it.index}`;
            if (a.Subtype === "Stamp" && !it.imageData && ctx.previewStamps) {
                // Preview only: the real image is rendered at import time.
                if (it.ap) out.push({ name: "bb-" + nm, xml: "", tag: "stamp", page: it.page, author: a.T || "", subject: a.Subj || "" });
                else skipped.push({ page: it.page, type: "Stamp", subject: a.Subj || "", reason: "stamp has no appearance to render" });
                continue;
            }
            let res;
            try {
                res = annotToXfdf(a, {
                imageData: it.imageData,
                stampOpacity: ctx.stampOpacity,
                page: it.page,
                author: ctx.author,
                markupOBID: ctx.markupOBID,
                name: "bb-" + nm,
                parentName: it.parentNM ? "bb-" + it.parentNM : null,
                importedAt
            });
            } catch (e) {
                res = { skip: "conversion error: " + (e && e.message ? e.message : e) };
            }
            if (res.skip) skipped.push({ page: it.page, type: a.Subtype || "?", subject: a.Subj || "", reason: res.skip });
            else out.push({ name: "bb-" + nm, xml: res.xml, tag: res.tag, page: it.page, author: a.T || "", subject: a.Subj || "" });
        }
        return { items: out, skipped };
    }

    // PDF 32000 12.5.5: the appearance BBox is transformed by its Matrix, and the
    // bounding box of the result is fitted to the annotation Rect. Returns the
    // size of the target (pt) and the content stream that draws the form into a
    // page whose origin is the bottom-left of the Rect.
    function stampPlacement(rectIn, bboxIn, matrixIn) {
        const rect = normRect(rectIn);
        const b = normRect(bboxIn);
        const m = Array.isArray(matrixIn) && matrixIn.length === 6 ? matrixIn : [1, 0, 0, 1, 0, 0];
        if (!rect || !b) return null;
        const corners = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]
            .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
        const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const W = rect[2] - rect[0], H = rect[3] - rect[1];
        if (!(x1 > x0) || !(y1 > y0) || !(W > 0) || !(H > 0)) return null;
        const sx = W / (x1 - x0), sy = H / (y1 - y0);
        const f = v => v.toFixed(6);
        return { W, H, content: `q ${f(sx)} 0 0 ${f(sy)} ${f(-x0 * sx)} ${f(-y0 * sy)} cm /Fm0 Do Q` };
    }

    function mergeIntoXfdf(existingXml, fragments) {
        const base = existingXml && /<annots[\s>\/]/.test(existingXml)
            ? existingXml
            : '<?xml version="1.0" encoding="UTF-8" ?><xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots /></xfdf>';
        const have = new Set();
        const re = /\sname="([^"]*)"/g;
        let m;
        while ((m = re.exec(base))) have.add(m[1]);
        const fresh = fragments.filter(f => !have.has(f.name));
        const frag = fresh.map(f => f.xml).join("");
        let merged;
        if (/<annots\s*\/>/.test(base)) {
            merged = base.replace(/<annots\s*\/>/, `<annots>${frag}</annots>`);
        } else {
            const idx = base.lastIndexOf("</annots>");
            merged = base.slice(0, idx) + frag + base.slice(idx);
        }
        return { xml: merged, added: fresh.length, duplicates: fragments.length - fresh.length };
    }
    // Compares page counts/sizes of the Bluebeam PDF with the document open in SDx.
    // Orientation-insensitive (a rotated page swaps width/height).
    function comparePageSizes(bb, sdx) {
        if (!Array.isArray(sdx) || !sdx.length) {
            return { status: "unknown", message: "Could not read the SDx document's pages to verify this is the same revision." };
        }
        if (bb.length !== sdx.length) {
            return { status: "fail", message: `Page count differs: the Bluebeam PDF has ${bb.length} page(s), the SDx document has ${sdx.length}. This is probably a different revision.`, mismatches: [] };
        }
        const mismatches = [];
        for (let i = 0; i < bb.length; i++) {
            const a = [bb[i].w, bb[i].h].sort((x, y) => x - y);
            const b = [sdx[i].w, sdx[i].h].sort((x, y) => x - y);
            const tol = Math.max(2, 0.01 * Math.max(a[1], b[1]));
            if (Math.abs(a[0] - b[0]) > tol || Math.abs(a[1] - b[1]) > tol) mismatches.push(i + 1);
        }
        if (mismatches.length) {
            const shown = mismatches.slice(0, 12).join(", ") + (mismatches.length > 12 ? ", ..." : "");
            return { status: "warn", message: `${mismatches.length} page(s) differ in size from the SDx document (page ${shown}). The PDFs may be different revisions, so comments could land in the wrong place.`, mismatches };
        }
        return { status: "ok", message: `Page count and sizes match the SDx document (${bb.length} pages).`, mismatches: [] };
    }

    // ---- Undo support: finds/removes comments added by this tool (name starts with "bb-") ----
    function xmlUnesc(v) {
        return String(v)
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
    function parseAttrString(str) {
        const out = {};
        const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let m;
        while ((m = re.exec(str))) out[m[1]] = xmlUnesc(m[2] !== undefined ? m[2] : m[3]);
        return out;
    }
    // Returns the direct children of <annots> with their character ranges.
    function scanTopLevelAnnots(xml) {
        const open = /<annots(\s[^>]*)?>/.exec(xml);
        if (!open || /\/>$/.test(open[0])) return [];
        const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
        tag.lastIndex = open.index + open[0].length;
        const out = [];
        let depth = 1, cur = null, t;
        while ((t = tag.exec(xml))) {
            const close = t[1] === "/", self = t[4] === "/";
            if (close) {
                depth--;
                if (depth === 1 && cur) { cur.end = tag.lastIndex; out.push(cur); cur = null; }
                if (depth === 0) break;
            } else {
                if (depth === 1) {
                    cur = { start: t.index, name: t[2], attrs: parseAttrString(t[3]) };
                    if (self) { cur.end = tag.lastIndex; out.push(cur); cur = null; continue; }
                }
                if (!self) depth++;
            }
        }
        for (const el of out) {
            const chunk = xml.slice(el.start, el.end);
            const m = /<trn-custom-data\s[^>]*?bytes="([^"]*)"/.exec(chunk);
            el.importedAt = "";
            if (m) {
                try { el.importedAt = JSON.parse(xmlUnesc(m[1])).bbImportedAt || ""; } catch {}
            }
        }
        return out;
    }
    // mode: "last" = only the most recent import, "all" = every comment added by this tool.
    function removeImported(xml, mode) {
        const els = scanTopLevelAnnots(xml);
        const mine = els.filter(e => String(e.attrs.name || "").startsWith("bb-"));
        const imports = Array.from(new Set(mine.map(e => e.importedAt))).sort();
        const latest = imports.length ? imports[imports.length - 1] : "";
        const doomed = new Set(mine.filter(e => mode === "all" || e.importedAt === latest));
        const names = new Set(Array.from(doomed).map(e => e.attrs.name));
        let grew = true;
        while (grew) {
            grew = false;
            for (const e of els) {
                if (!doomed.has(e) && e.attrs.inreplyto && names.has(e.attrs.inreplyto)) {
                    doomed.add(e); names.add(e.attrs.name); grew = true;
                }
            }
        }
        let out = xml;
        for (const e of Array.from(doomed).sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + out.slice(e.end);
        return { xml: out, removed: doomed.size, imports, latest };
    }
    // Groups skipped/failed items so the user can see which pages and comment types did not come in.
    function summarizeSkipped(skipped) {
        const groups = new Map();
        for (const sk of skipped || []) {
            const key = `${sk.type || "?"}|${sk.reason || "unknown reason"}`;
            if (!groups.has(key)) groups.set(key, { type: sk.type || "?", reason: sk.reason || "unknown reason", pages: new Set(), count: 0 });
            const g = groups.get(key);
            g.count++;
            if (Number.isFinite(sk.page)) g.pages.add(sk.page + 1);
        }
        return Array.from(groups.values())
            .map(g => ({ type: g.type, reason: g.reason, count: g.count, pages: Array.from(g.pages).sort((a, b) => a - b) }))
            .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    }
    function formatPages(pages) {
        if (!pages.length) return "";
        const out = [];
        let start = pages[0], prev = pages[0];
        for (let i = 1; i <= pages.length; i++) {
            const v = pages[i];
            if (v === prev + 1) { prev = v; continue; }
            out.push(start === prev ? String(start) : `${start}-${prev}`);
            start = prev = v;
        }
        return out.join(", ");
    }
    // Re-tags other reviewers' comments so they can be embedded in the working copy:
    // names get an "sdx-ex-" prefix (the importer skips these) and they are marked locked.
    function buildExistingXfdf(layers) {
        const frags = [], summary = [];
        const openTag = /^<([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/;
        let n = 0;
        for (const L of layers) {
            const xml = L.xml || "";
            for (const e of scanTopLevelAnnots(xml)) {
                const chunk = xml.slice(e.start, e.end);
                const m = openTag.exec(chunk);
                if (!m) continue;
                n++;
                let attrStr = m[2];
                const setAttr = (k, v) => {
                    const re = new RegExp("(\\s" + k + "\\s*=\\s*)(?:\"[^\"]*\"|'[^']*')");
                    attrStr = re.test(attrStr) ? attrStr.replace(re, (mm, pre) => pre + '"' + xmlEsc(v) + '"') : attrStr + ` ${k}="${xmlEsc(v)}"`;
                };
                setAttr("name", "sdx-ex-" + (e.attrs.name || `${L.id || "layer"}-${n}`));
                if (e.attrs.inreplyto) setAttr("inreplyto", "sdx-ex-" + e.attrs.inreplyto);
                setAttr("flags", "print,locked");
                frags.push("<" + m[1] + attrStr + m[3] + ">" + chunk.slice(m[0].length));
                const t = /<contents>([\s\S]*?)<\/contents>/.exec(chunk);
                summary.push({
                    page: Number(e.attrs.page) + 1, author: e.attrs.title || L.owner || "", type: m[1],
                    subject: e.attrs.subject || "", text: t ? xmlUnesc(t[1]).trim() : "", layer: L.name || ""
                });
            }
        }
        const xml = `<?xml version="1.0" encoding="UTF-8" ?><xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots>${frags.join("")}</annots></xfdf>`;
        return { xml, count: frags.length, summary };
    }
    // Does the uploaded PDF's file name look like the document open in SDx?
    // Ignores extensions, export timestamps (_YYYYMMDD-HHMMSS), upload suffixes and copy markers.
    function normDocName(n) {
        return String(n || "").toLowerCase()
            .replace(/\.pdf$/i, "")
            .replace(/[\s_-]*\d{8}-\d{6}$/, "")
            .replace(/\s*\(\d+\)$/, "")
            .replace(/[\s_-]*(copy|for bluebeam)$/i, "")
            .replace(/[-_][0-9a-f]{8}$/, "")
            .replace(/[^a-z0-9]/g, "");
    }
    function bigramDice(a, b) {
        if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
        const grams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
        const A = grams(a), B = grams(b);
        let hit = 0;
        for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0);
        return (2 * hit) / ((a.length - 1) + (b.length - 1));
    }
    function compareNames(uploadedName, docName) {
        const a = normDocName(uploadedName), b = normDocName(docName);
        if (!a || !b) return { ok: true, unknown: true };
        if ((a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b))) return { ok: true };
        if (bigramDice(a, b) >= 0.75) return { ok: true };
        return { ok: false, message: `The uploaded file name ("${uploadedName}") does not match the document open in SDx ("${docName}").` };
    }
    // ==CONVERTER-END==

    /************************************************************
     * pdf-lib glue: read every annotation off every page
     ************************************************************/
    function pdfToJs(ctx, o, depth) {
        const P = window.PDFLib;
        depth = depth || 0;
        if (depth > 6) return undefined;
        while (o instanceof P.PDFRef) o = ctx.lookup(o);
        if (o === undefined || o === null) return undefined;
        if (o instanceof P.PDFName) return o.decodeText();
        if (o instanceof P.PDFString || o instanceof P.PDFHexString) return o.decodeText();
        if (o instanceof P.PDFNumber) return o.asNumber();
        if (o instanceof P.PDFBool) return o.asBoolean();
        if (o instanceof P.PDFArray) return o.asArray().map(x => pdfToJs(ctx, x, depth + 1));
        if (o instanceof P.PDFRawStream || (P.PDFStream && o instanceof P.PDFStream)) return undefined;
        if (o instanceof P.PDFDict) {
            const out = {};
            for (const [k, v] of o.entries()) {
                const key = k.decodeText();
                if (key === "AP" || key === "P" || key === "Parent" || key === "Popup" || key === "IRT" || key === "OC") continue;
                out[key] = pdfToJs(ctx, v, depth + 1);
            }
            return out;
        }
        return undefined;
    }

    async function readBluebeamPdf(arrayBuffer) {
        const P = window.PDFLib;
        const doc = await P.PDFDocument.load(arrayBuffer, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
        const ctx = doc.context;
        const pages = doc.getPages();
        const items = [];
        const authors = new Map();
        let existingSkipped = 0;
        const pageSizes = pages.map(pg => {
            try { const b = pg.getCropBox(); return { w: b.width, h: b.height }; } catch { const sz = pg.getSize(); return { w: sz.width, h: sz.height }; }
        });
        pages.forEach((page, pageIdx) => {
            const annots = page.node.Annots();
            if (!annots) return;
            for (let i = 0; i < annots.size(); i++) {
                let dict = null;
                try { dict = annots.lookupMaybe(i, P.PDFDict); } catch { dict = null; }
                if (!dict) continue;
                let a;
                try { a = pdfToJs(ctx, dict); } catch { continue; }
                if (!a || a.Subtype === "Popup" || a.Subtype === "Link" || a.Subtype === "Widget") continue;
                if (typeof a.NM === "string" && a.NM.startsWith("sdx-ex-")) { existingSkipped++; continue; }
                let parentNM = null;
                try {
                    const irt = dict.lookupMaybe(P.PDFName.of("IRT"), P.PDFDict);
                    if (irt) {
                        const nmObj = irt.lookupMaybe(P.PDFName.of("NM"), P.PDFString, P.PDFHexString);
                        parentNM = nmObj ? nmObj.decodeText() : null;
                    }
                } catch {}
                let ap = null;
                if (a.Subtype === "Stamp") {
                    try {
                        const apDict = dict.lookupMaybe(P.PDFName.of("AP"), P.PDFDict);
                        const nRaw = apDict && apDict.get(P.PDFName.of("N"));
                        const n = nRaw && ctx.lookup(nRaw);
                        if (n && n.dict) {
                            const nd = pdfToJs(ctx, n.dict) || {};
                            ap = {
                                ref: nRaw instanceof P.PDFRef ? nRaw : ctx.register(n),
                                bbox: nd.BBox,
                                matrix: nd.Matrix
                            };
                        }
                    } catch {}
                }
                items.push({ page: pageIdx, index: i, a, parentNM, ap });
                const who = a.T || "(no author)";
                authors.set(who, (authors.get(who) || 0) + 1);
            }
        });
        return { pageCount: pages.length, items, authors, doc, pageSizes, existingSkipped };
    }

    function getPdfJs() {
        const pdfjs = window.pdfjsLib || window["pdfjs-dist/build/pdf"];
        if (!pdfjs) throw new Error("pdf.js did not load (check Tampermonkey @require)");
        if (!window.pdfjsWorker && window["pdfjs-dist/build/pdf.worker"]) window.pdfjsWorker = window["pdfjs-dist/build/pdf.worker"];
        pdfjs.GlobalWorkerOptions.workerSrc = pdfjs.GlobalWorkerOptions.workerSrc || "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        return pdfjs;
    }
    // Counts non-white pixels so a blank render can be detected and reported.
    function inkPixels(canvas) {
        const c = canvas.getContext("2d", { willReadFrequently: true });
        const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) n++;
        }
        return n;
    }
    function canvasToPng(canvas) {
        let url = canvas.toDataURL("image/png");
        if (url.length > 6 * 1024 * 1024) {
            const small = document.createElement("canvas");
            small.width = Math.round(canvas.width * 0.6);
            small.height = Math.round(canvas.height * 0.6);
            const c = small.getContext("2d");
            c.fillStyle = "#fff"; c.fillRect(0, 0, small.width, small.height);
            c.drawImage(canvas, 0, 0, small.width, small.height);
            url = small.toDataURL("image/png");
        }
        return url;
    }

    // Method A: draw the stamp's own appearance stream (includes any markups that
    // were baked into the snapshot) via a temporary one-page copy.
    async function renderStampFromAppearance(srcDoc, item) {
        const P = window.PDFLib;
        const pdfjs = getPdfJs();
        const place = stampPlacement(item.a.Rect, item.ap.bbox, item.ap.matrix);
        if (!place) throw new Error("bad stamp geometry");
        const ctx = srcDoc.context;
        const tmpPage = srcDoc.addPage([place.W, place.H]);
        let bytes;
        try {
            tmpPage.node.setXObject(P.PDFName.of("Fm0"), item.ap.ref);
            tmpPage.node.addContentStream(ctx.register(ctx.stream(place.content)));
            const tmp = await P.PDFDocument.create();
            const [copied] = await tmp.copyPages(srcDoc, [srcDoc.getPageCount() - 1]);
            tmp.addPage(copied);
            bytes = await tmp.save();
        } finally {
            srcDoc.removePage(srcDoc.getPageCount() - 1);
        }
        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        try {
            const page = await pdf.getPage(1);
            const scale = Math.min(4, 2400 / Math.max(place.W, place.H));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));
            const c2d = canvas.getContext("2d");
            c2d.fillStyle = "#fff";
            c2d.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: c2d, viewport }).promise;
            return canvas;
        } finally {
            try { await pdf.destroy(); } catch {}
        }
    }

    // Method B (fallback): render the original page without annotations and crop
    // the snapshot's rectangle out of it. Same pixels Bluebeam captured from the
    // page itself, but markups that were baked into the snapshot are not included.
    async function renderStampFromPage(bytes, item) {
        const pdfjs = getPdfJs();
        const rect = normRect(item.a.Rect);
        const W = rect[2] - rect[0], H = rect[3] - rect[1];
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
        try {
            const page = await pdf.getPage(item.page + 1);
            const base = page.getViewport({ scale: 1, rotation: 0 });
            let scale = Math.min(4, 2400 / Math.max(W, H));
            scale = Math.min(scale, Math.sqrt(30e6 / (base.width * base.height)));
            const viewport = page.getViewport({ scale, rotation: 0 });
            const full = document.createElement("canvas");
            full.width = Math.round(viewport.width);
            full.height = Math.round(viewport.height);
            const fc = full.getContext("2d");
            fc.fillStyle = "#fff";
            fc.fillRect(0, 0, full.width, full.height);
            await page.render({ canvasContext: fc, viewport, annotationMode: 0 }).promise;
            const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([rect[0], rect[1], rect[2], rect[3]]);
            const cx = Math.min(x1, x2), cy = Math.min(y1, y2);
            const cw = Math.max(1, Math.round(Math.abs(x2 - x1))), ch = Math.max(1, Math.round(Math.abs(y2 - y1)));
            const out = document.createElement("canvas");
            out.width = cw; out.height = ch;
            const oc = out.getContext("2d");
            oc.fillStyle = "#fff"; oc.fillRect(0, 0, cw, ch);
            oc.drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);
            return out;
        } finally {
            try { await pdf.destroy(); } catch {}
        }
    }

    async function renderStampPng(srcDoc, item, bytes) {
        let canvas = null, ink = 0, via = "appearance";
        try {
            canvas = await renderStampFromAppearance(srcDoc, item);
            ink = inkPixels(canvas);
        } catch (e) {
            warn("Appearance render failed, will try page crop:", e);
        }
        if (!canvas || ink < 50) {
            warn(`Stamp ${item.a.NM || ""}: appearance render ${canvas ? "was blank" : "failed"}; falling back to page crop.`);
            canvas = await renderStampFromPage(bytes, item);
            ink = inkPixels(canvas);
            via = "page-crop";
        }
        log(`Stamp ${item.a.NM || ""} on page ${item.page + 1}: ${canvas.width}x${canvas.height}px via ${via}, ${ink} non-white pixels.`);
        if (ink < 50) warn("Stamp image still looks blank - please report this.");
        return canvasToPng(canvas);
    }

    /************************************************************
     * Session / network capture (same approach as Reviewer Wizard)
     ************************************************************/
    const state = {
        authHeaders: readJson(AUTH_KEY, {}),
        config: "",
        apiBase: "",
        fileOBID: "",
        lastMarkupOBID: "",
        saveTemplate: { ActionPinOBIDs: "", ActionInterface: "ISCLBAction", RelDefForActionRenditionGen: "SCLBCommunicationItemsMarkupFiles" },
        me: null,
        layers: [],
        otherLayers: [],
        parsed: null,
        converted: null,
        busy: false,
        check: null,
        createTemplate: { markupContextOBID: "", renditionOBID: "", relDefContext: "SDAMarkupContext", relDefRendition: "SCLBDocVersionsMarkupFiles", groupOBID: "" },
        createOpts: null,
        layerChoice: "",
        layerTouched: false,
        step2Done: false,
        checkAck: false,
        docId: "",
        workByDoc: {},
        newLayer: { type: readJson("sdxbm_layer_type", "e1Document_Review"), group: "", desc: "" },
        lastResult: null,
        view: "import",
        work: { dir: null, dirName: "", fileHandle: null, fileName: "", baseline: 0, lastSeen: 0, stable: 0, savedAt: 0, notified: 0, auto: false, includeExisting: readJson("sdxbm_include_existing", true) !== false, existing: null, existingNote: "", unlock: readJson("sdxbm_unlock", true) !== false, unlockNote: "", timer: null, path: readJson("sdxbm_work_path", ""), old: null, oldChecked: false, oldNote: "", autoChecked: false },
        sdxPages: null,
        stampOpacity: Math.min(1, Math.max(0, Number(readJson("sdxbm_stamp_opacity", 0.7)) || 0.7))
    };

    function log(...a) { console.log(`%c${ICON} [${TOOL} v${VERSION}]`, "color:#0078d4;font-weight:bold", ...a); }
    function warn(...a) { console.warn(`%c${ICON} [${TOOL} v${VERSION}]`, "color:#c77d00;font-weight:bold", ...a); }
    function readJson(key, fallback) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch { return fallback; } }
    function writeJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }
    function safeJson(t, f = null) { try { return JSON.parse(t); } catch { return f; } }
    function esc(v) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

    class AuthError extends Error {}

    function headersToObject(headers) {
        const obj = {};
        try {
            if (!headers) return obj;
            if (headers instanceof Headers) { headers.forEach((v, k) => { obj[String(k).toLowerCase()] = v; }); return obj; }
            if (Array.isArray(headers)) { for (const [k, v] of headers) obj[String(k).toLowerCase()] = v; return obj; }
            for (const k of Object.keys(headers)) obj[String(k).toLowerCase()] = headers[k];
        } catch {}
        return obj;
    }
    function stripBearer(v) { return String(v || "").replace(/^Bearer\s+/i, "").trim(); }
    function looksLikeJwt(v) { return typeof v === "string" && v.split(".").length === 3; }
    function jwtExpiryMs(token) {
        try {
            const part = String(token).split(".")[1];
            const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
            const exp = Number(JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))).exp);
            return Number.isFinite(exp) ? exp * 1000 : 0;
        } catch { return 0; }
    }
    function getSessionStorageTokens() {
        const found = [];
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (!key || !/auth/i.test(key)) continue;
                const raw = sessionStorage.getItem(key);
                if (!raw) continue;
                try {
                    const p = JSON.parse(raw);
                    const c = p && (p.authorization || p.Authorization || p.accessToken || p.access_token || p.token);
                    if (typeof c === "string" && looksLikeJwt(stripBearer(c))) found.push(stripBearer(c));
                } catch {
                    if (looksLikeJwt(stripBearer(raw))) found.push(stripBearer(raw));
                }
            }
        } catch {}
        return found;
    }
    function getBestAuthorization(forceFreshest = false) {
        const captured = stripBearer(state.authHeaders.authorization);
        const all = [captured, ...getSessionStorageTokens()].filter(Boolean);
        if (!all.length) return "";
        if (!forceFreshest && captured) {
            const exp = jwtExpiryMs(captured);
            if (exp === 0 || exp > Date.now() + 30000) return "Bearer " + captured;
        }
        let best = all[0], bestExp = jwtExpiryMs(best);
        for (const t of all) { const e = jwtExpiryMs(t); if (e > bestExp) { best = t; bestExp = e; } }
        return "Bearer " + best;
    }
    function isSdxApiUrl(urlStr) {
        try {
            const u = new URL(urlStr, location.origin);
            return u.origin === location.origin && u.pathname.toLowerCase().includes("/api/");
        } catch { return false; }
    }
    function rememberHeaders(headers, url) {
        const h = headersToObject(headers);
        let changed = false;
        if (h.authorization && h.authorization !== state.authHeaders.authorization) {
            const ne = jwtExpiryMs(stripBearer(h.authorization));
            const oe = jwtExpiryMs(stripBearer(state.authHeaders.authorization));
            if (!state.authHeaders.authorization || ne >= oe) { state.authHeaders.authorization = h.authorization; changed = true; }
        }
        if (changed) { state.authHeaders.capturedAt = new Date().toISOString(); writeJson(AUTH_KEY, state.authHeaders); updateModalSession(); }
        const cfg = h.spfcreateconfiguid || h.spfqueryconfiguid || h.spfconfiguid;
        if (cfg) state.config = cfg;
        try {
            const m = new URL(url, location.origin).pathname.match(/^(.*?\/api\/v\d+)\//i);
            if (m) state.apiBase = m[1];
        } catch {}
    }
    function sniffRequest(url, body) {
        const u = String(url || "");
        let m = u.match(/Objects\('([A-Za-z0-9]+)'\)\/SPFFileMarkup_12/i);
        if (m) setFile(m[1]);
        const text = typeof body === "string" ? body : "";
        if (/GetWatermarksOnFile/i.test(u)) {
            const j = safeJson(text);
            if (j && j.pstrFileOBID) setFile(j.pstrFileOBID);
        }
        if (/\$batch/i.test(u) && /CreateMarkup/.test(text)) {
            const g = re => { const m = text.match(re); return m ? m[1] : ""; };
            const t = {
                markupContextOBID: g(/"MarkupContextObjectOBID"\s*:\s*"(\w+)"/),
                renditionOBID: g(/"ObjectOBIDForRenditionGeneration"\s*:\s*"(\w+)"/),
                relDefContext: g(/"RelDefFromContextObjectToMarkupFile"\s*:\s*"(\w+)"/),
                relDefRendition: g(/"RelDefForRenditionGeneration"\s*:\s*"(\w+)"/),
                groupOBID: g(/SPFItemOwningGroup_12@odata\.bind"\s*:\s*\["[^"]*Objects\('(\w+)'\)/)
            };
            for (const [k, v] of Object.entries(t)) if (v) state.createTemplate[k] = v;
        }
        if (/\/SDA\/SaveMarkup/i.test(u)) {
            const j = safeJson(text);
            if (j && j.MarkupOBID) {
                state.lastMarkupOBID = j.MarkupOBID;
                for (const k of ["ActionPinOBIDs", "ActionInterface", "RelDefForActionRenditionGen"]) {
                    if (j[k] !== undefined) state.saveTemplate[k] = j[k];
                }
            }
        }
    }
    function setFile(id) {
        // The page address is authoritative for which document is open; ignore stray requests for other files.
        const nav = readNavContext().fileOBID;
        if (nav && id !== nav) return;
        if (id && id !== state.fileOBID) {
            state.fileOBID = id;
            state.lastMarkupOBID = "";
            state.layers = [];
        }
    }
    // ---- Which document is being reviewed right now? (SDx is a single-page app, so the tab survives navigation.) ----
    const PER_DOC_WORK = ["fileHandle", "fileName", "baseline", "lastSeen", "stable", "savedAt", "notified", "existing", "existingNote", "unlockNote"];
    const PER_DOC_DEFAULTS = { fileHandle: null, fileName: "", baseline: 0, lastSeen: 0, stable: 0, savedAt: 0, notified: 0, existing: null, existingNote: "", unlockNote: "" };
    function currentDocId() {
        const n = readNavContext();
        return n.fileOBID || state.fileOBID || "";
    }
    function currentDocName() {
        try {
            const url = findSdxPdfUrl();
            if (url) {
                const seg = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
                if (seg) return safeFileBase(seg);
            }
        } catch {}
        try {
            const v = getViewerDoc();
            const n = v && v.doc.getFilename && v.doc.getFilename();
            if (n) return safeFileBase(n);
        } catch {}
        return state.docId ? "document " + state.docId : "";
    }
    function stashWork(docId) {
        if (!docId) return;
        const snap = {};
        for (const k of PER_DOC_WORK) snap[k] = state.work[k];
        state.workByDoc[docId] = snap;
    }
    function restoreWork(docId) {
        Object.assign(state.work, PER_DOC_DEFAULTS, state.workByDoc[docId] || {});
        if (state.work.timer) { clearInterval(state.work.timer); state.work.timer = null; }
        if (state.work.fileHandle) startWatch();
    }
    function syncDocument() {
        const id = currentDocId();
        if (!id || id === state.docId) return;
        const prev = state.docId;
        state.docId = id;
        state.fileOBID = id;
        state.lastMarkupOBID = "";
        state.layers = [];
        state.otherLayers = [];
        if (!prev) return;
        log(`Document changed (${prev} -> ${id}); resetting per-document state.`);
        stashWork(prev);
        restoreWork(id);
        state.check = null; state.checkAck = false; state.sdxPages = null;
        state.parsed = null; state.converted = null; state.lastResult = null;
        state.layerChoice = ""; state.layerTouched = false; state.step2Done = false;
        state.createTemplate.markupContextOBID = ""; state.createTemplate.renditionOBID = "";
        if (isModalOpen()) {
            render();
            if (state.view !== "export") refreshLayers();
        }
    }
    function projectKeyFromUrl() {
        try {
            const m = location.href.match(/queryFilter=([^;]+)/i);
            if (m) {
                const p = JSON.parse(decodeURIComponent(m[1]));
                return p?.config?.key || p?.config?.value || "";
            }
        } catch {}
        return "";
    }
    function installHooks() {
        if (window.__sdxbm_hooks) return;
        window.__sdxbm_hooks = true;
        const origFetch = window.fetch;
        window.fetch = function (...args) {
            try {
                const input = args[0], init = args[1] || {};
                let url = "", headers = {};
                if (input instanceof Request) { url = input.url; headers = headersToObject(input.headers); }
                else url = String(input || "");
                if (init.headers) headers = { ...headers, ...headersToObject(init.headers) };
                if (isSdxApiUrl(url)) { rememberHeaders(headers, url); sniffRequest(url, init.body); }
            } catch {}
            return origFetch.apply(this, args);
        };
        const oOpen = XMLHttpRequest.prototype.open;
        const oSend = XMLHttpRequest.prototype.send;
        const oSet = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function (method, url) { this.__bmUrl = url; this.__bmH = {}; return oOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__bmH[String(k).toLowerCase()] = v; } catch {} return oSet.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function (body) {
            try {
                const url = this.__bmUrl || "";
                if (isSdxApiUrl(url)) { rememberHeaders(this.__bmH, url); sniffRequest(url, body); }
            } catch {}
            return oSend.apply(this, arguments);
        };
    }

    function apiRoot() {
        return location.origin + (state.apiBase || DEFAULT_API_BASE);
    }
    function apiHeaders() {
        const h = { accept: "application/json, text/plain, */*", "content-type": "application/json" };
        const auth = getBestAuthorization();
        if (auth) h.authorization = auth;
        const cfg = state.config || projectKeyFromUrl();
        if (cfg) { h.SPFCreateConfigUID = cfg; h.SPFQueryConfigUID = cfg; }
        return h;
    }
    async function api(path, { method = "GET", body } = {}) {
        const go = async headers => fetch(apiRoot() + path, {
            method, headers, credentials: "include", mode: "cors",
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        let res = await go(apiHeaders());
        if (res.status === 401) {
            const fresh = getBestAuthorization(true);
            if (fresh) res = await go({ ...apiHeaders(), authorization: fresh });
        }
        if (res.status === 401 || res.status === 403) {
            throw new AuthError(`Session expired or not captured (HTTP ${res.status}). Click anything in SDx that loads data (open a filter or search), then retry.`);
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`${path.split("?")[0]} failed: ${res.status} ${text.slice(0, 300)}`);
        return safeJson(text, text);
    }

    // Context for creating a new markup layer: from the page URL, else from a native create we saw.
    function readNavContext() {
        const out = {};
        try {
            for (const part of location.hash.replace(/^#\/?/, "").split(";").slice(1)) {
                const i = part.indexOf("=");
                if (i < 0) continue;
                let v = part.slice(i + 1);
                try { v = decodeURIComponent(v); } catch {}
                out[part.slice(0, i)] = v;
            }
            if (out.data) {
                const j = safeJson(out.data) || safeJson(String(out.data).replace(/'/g, '"'));
                if (j && typeof j === "object") Object.assign(out, j);
            }
        } catch {}
        return out;
    }
    function getCreateContext() {
        const n = readNavContext(), t = state.createTemplate;
        if (n.fileOBID && !state.fileOBID) setFile(n.fileOBID);
        return {
            markupContextOBID: n.markupContextOBID || t.markupContextOBID,
            renditionOBID: n.objectOBIDForRenditionGeneration || n.fileCompositionOBID || n.documentReviewVersionOBID || t.renditionOBID,
            relDefContext: t.relDefContext,
            relDefRendition: t.relDefRendition,
            config: n.fileConfig || state.config || projectKeyFromUrl()
        };
    }
    function uuid() {
        return (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
    }
    const FALLBACK_TYPES = [["e1Blank", "Blank"], ["e1Constructability", "Constructability"], ["e1Document_Review", "Document Review"], ["e1HAZOP", "HAZOP"], ["e1Model_Review", "Model Review"], ["e1Process", "Process"]]
        .map(([id, name]) => ({ id, name }));
    async function loadCreateOptions() {
        if (state.createOpts) return state.createOpts;
        let types = FALLBACK_TYPES, groups = [];
        try {
            const r = await api("/SDA/SelectLists('e1MarkupType')?$expand=Items,Descendants");
            const items = (r.Items || []).filter(i => !i.IsDisabled).map(i => ({ id: i.Id, name: i.DisplayName || i.DisplayAs || i.Name }));
            if (items.length) types = items;
        } catch (e) { warn("Could not load markup types, using defaults:", e); }
        try {
            const r = await api("/SDA/GetFormDropDownOptions(DisplayItemUID='DI_ItemOwningGroup_Create',%20FileObjOBID='')");
            groups = (r.value || []).map(g => ({ id: g.OBID, name: g.DisplayValue || g.UID }));
        } catch (e) { warn("Could not load owning groups:", e); }
        if (!groups.length && state.createTemplate.groupOBID) groups = [{ id: state.createTemplate.groupOBID, name: state.createTemplate.groupOBID }];
        state.createOpts = { types, groups };
        if (!types.some(t => t.id === state.newLayer.type)) state.newLayer.type = (types.find(t => t.id === "e1Document_Review") || types[0]).id;
        if (!state.newLayer.group || !groups.some(g => g.id === state.newLayer.group)) state.newLayer.group = groups[0] ? groups[0].id : "";
        return state.createOpts;
    }
    // Creates a new, empty markup layer exactly like SDx's own "New Layer" does.
    async function createLayer(typeId, groupId, description) {
        const c = getCreateContext();
        if (!state.fileOBID) throw new Error("No document detected yet. Wait for the viewer to finish loading.");
        if (!c.markupContextOBID || !c.renditionOBID) {
            throw new Error("Could not work out the context for a new layer on this page. Click SDx's own NEW LAYER once, then retry (the importer will learn it).");
        }
        if (!groupId) throw new Error("No owning group available for the new layer.");
        const base = apiRoot();
        const b = "batch_" + uuid(), cs = "changeset_" + uuid();
        const create = {
            Class: "SPFMarkupFile", Name: "TBA: To be allocated using ENS", Description: description || "", SPFMarkupType: typeId,
            SPFLocalFileName: Date.now() + ".xfdf", SPFIsMarkupConsolidated: false,
            "SPFItemOwningGroup_12@odata.bind": [`${base}/SDA/Objects('${groupId}')`],
            "SPFFileMarkup_21@odata.bind": [`${base}/SDA/Objects('${state.fileOBID}')`]
        };
        const markup = {
            MarkupOBID: "$0",
            MarkupContent: '<?xml version="1.0" encoding="UTF-8" ?><xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots /></xfdf>',
            MarkupContextObjectOBID: c.markupContextOBID, RelDefFromContextObjectToMarkupFile: c.relDefContext,
            RelDefForRenditionGeneration: c.relDefRendition, ObjectOBIDForRenditionGeneration: c.renditionOBID, IsBatchRequest: true
        };
        const part = (id, head, json) => [`--${cs}`, "Content-Type: application/http", "Content-Transfer-Encoding: binary", `Content-ID: ${id}`, "", ...head, "", JSON.stringify(json), ""];
        const body = [
            `--${b}`, `Content-Type: multipart/mixed; boundary=${cs}`, "Content-Transfer-Encoding: binary", "",
            ...part(0, [`POST ${base}/SDA/Objects HTTP/1.1`, "Accept: application/vnd.intergraph.data+json", `SPFConfigUID: ${c.config}`], create),
            ...part(1, [`POST ${base}/SDA/CreateMarkup HTTP/1.1`, "Accept: application/vnd.intergraph.columnset.CS_MarkupLayerManager+json"], markup),
            `--${cs}--`, "", `--${b}--`, ""
        ].join("\r\n");
        const go = headers => fetch(base + "/$batch", { method: "POST", headers, credentials: "include", mode: "cors", body });
        const hdr = auth => ({ accept: "application/json, text/plain, */*", "content-type": `multipart/mixed;boundary=${b}`, ...(auth ? { authorization: auth } : {}) });
        let res = await go(hdr(getBestAuthorization()));
        if (res.status === 401) { const fresh = getBestAuthorization(true); if (fresh) res = await go(hdr(fresh)); }
        if (res.status === 401 || res.status === 403) throw new AuthError(`Session expired or not captured (HTTP ${res.status}). Click anything in SDx that loads data, then retry.`);
        const text = await res.text();
        const failed = text.match(/HTTP\/1\.1 (4\d\d|5\d\d)[^\r\n]*/);
        const loc = text.match(/Objects\('(\w+)'\)/);
        if (!res.ok || failed || !loc) throw new Error("Creating the layer failed: " + (failed ? failed[0] : `HTTP ${res.status}`) + " " + text.slice(0, 300));
        state.lastMarkupOBID = loc[1];
        return { id: loc[1] };
    }

    async function loadMe() {
        if (state.me) return state.me;
        const u = await api("/User");
        state.me = { userName: u.UserName, display: u.DisplayName };
        return state.me;
    }
    async function loadLayers() {
        if (!state.fileOBID) throw new Error("No document detected yet. Open the markup viewer and wait for it to finish loading.");
        const me = await loadMe();
        let rows = [];
        const sel = "OBID,Name,CreationUser,CreationDate,SPFMarkupType,SPFIsMarkupLocked";
        try {
            const r = await api(`/SDA/Objects('${state.fileOBID}')/SPFFileMarkup_12?$select=${sel}&$count=true`);
            rows = r.value || [];
            if (rows.length && rows[0].CreationUser === undefined) throw new Error("no detail");
        } catch (e) {
            if (e instanceof AuthError) throw e;
            const r = await api(`/SDA/Objects('${state.fileOBID}')/SPFFileMarkup_12?$select=OBID&$count=true`);
            rows = [];
            for (const x of r.value || []) {
                try { rows.push(await api(`/SDA/Objects('${x.OBID}')`)); } catch {}
            }
        }
        const lower = s => String(s || "").toLowerCase();
        const anyOwner = rows.some(x => x.CreationUser);
        state.otherLayers = anyOwner
            ? rows.filter(x => lower(x.CreationUser) !== lower(me.userName)).map(x => ({ id: x.OBID, name: x.Name || x.OBID, owner: x.CreationUser || "" }))
            : [];
        state.layers = rows
            .filter(x => !anyOwner || lower(x.CreationUser) === lower(me.userName))
            .map(x => ({
                id: x.OBID, name: x.Name || x.OBID, type: x.SPFMarkupType || "", created: x.CreationDate || "",
                locked: Boolean(x.SPFIsMarkupLocked), owner: x.CreationUser || ""
            }))
            .sort((a, b) => String(b.created).localeCompare(String(a.created)));
        return state.layers;
    }

    /************************************************************
     * PDF security: detect locked/"sealed" PDFs and remove the restrictions
     * from a working COPY (the document stored in SDx is never modified).
     * Only works when the PDF opens without a password (owner-password
     * permission restrictions), same as qpdf --decrypt.
     ************************************************************/
    const QPDF_WASM_URL = "https://cdn.jsdelivr.net/npm/@neslinesli93/qpdf-wasm@0.3.0/dist/qpdf.wasm";
    async function inspectSecurity(bytes) {
        const pdfjs = getPdfJs();
        let pdf;
        try {
            pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
            const perms = await pdf.getPermissions();
            if (!perms) return { encrypted: false, canAnnotate: true, canModify: true };
            const F = pdfjs.PermissionFlag || { MODIFY_CONTENTS: 8, MODIFY_ANNOTATIONS: 32 };
            return { encrypted: true, canAnnotate: perms.includes(F.MODIFY_ANNOTATIONS), canModify: perms.includes(F.MODIFY_CONTENTS) };
        } catch (e) {
            if (e && (e.name === "PasswordException" || e.code === 1 || e.code === 2)) return { encrypted: true, needsPassword: true, canAnnotate: false, canModify: false };
            throw e;
        } finally {
            try { if (pdf) await pdf.destroy(); } catch {}
        }
    }
    async function qpdfDecrypt(bytes) {
        let factory = typeof Module === "function" ? Module : window.Module;
        if (typeof factory !== "function") {
            // Fallback: load qpdf.js as a normal page script so its global "Module" exists.
            await new Promise(resolve => {
                const sc = document.createElement("script");
                sc.src = QPDF_WASM_URL.replace(/qpdf\.wasm$/, "qpdf.js");
                sc.onload = sc.onerror = () => resolve();
                document.head.appendChild(sc);
            });
            factory = window.Module;
        }
        if (typeof factory !== "function") throw new Error("the PDF unlock library (qpdf) did not load - check Tampermonkey's @require access to cdn.jsdelivr.net");
        // Same flags BentoPDF uses ("--decrypt --remove-restrictions"), then plain --decrypt as a fallback.
        const attempts = [["--decrypt", "--remove-restrictions"], ["--decrypt"]];
        let lastErr = "";
        for (const flags of attempts) {
            const lines = [];
            try {
                const qpdf = await factory({ locateFile: () => QPDF_WASM_URL, noInitialRun: true, print: m => lines.push(m), printErr: m => lines.push(m) });
                qpdf.FS.writeFile("/in.pdf", new Uint8Array(bytes));
                let code;
                try { code = qpdf.callMain([...flags, "/in.pdf", "/out.pdf"]); } catch (e) { code = e && typeof e.status === "number" ? e.status : 2; }
                if (code === 0 || code === 3) {
                    const out = qpdf.FS.readFile("/out.pdf");
                    log(`qpdf ${flags.join(" ")} OK (exit ${code}).`, lines.slice(-3));
                    return { buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), flags: flags.join(" "), messages: lines.slice(-3) };
                }
                lastErr = `qpdf ${flags.join(" ")} exited ${code}: ${lines.slice(-3).join(" | ")}`;
            } catch (e) {
                lastErr = `qpdf ${flags.join(" ")} crashed: ${e && e.message ? e.message : e}`;
            }
            warn(lastErr);
        }
        throw new Error(lastErr || "qpdf failed");
    }
    // Signed/"sealed" PDFs can carry certification (DocMDP) or usage-rights entries that also block edits.
    function hasSignatureRestrictions(bytes) {
        try {
            const text = new TextDecoder("latin1").decode(new Uint8Array(bytes));
            return /\/DocMDP|\/UR3|\/Perms\b/.test(text);
        } catch { return false; }
    }
    // Returns { bytes, note } - bytes are unlocked when the PDF was encrypted/sealed and removal is allowed.
    async function unlockIfNeeded(bytes, allowUnlock) {
        const sec = await inspectSecurity(bytes);
        if (sec.needsPassword) return { bytes, note: "This PDF needs a password to open, so its restrictions cannot be removed.", failed: true };
        const sealed = !sec.encrypted && hasSignatureRestrictions(bytes);
        if (!sec.encrypted && !sealed) return { bytes, note: "" };
        if (!allowUnlock) {
            const locked = sec.encrypted && !sec.canAnnotate;
            return { bytes, note: locked ? 'WARNING: this PDF restricts adding markups, so Bluebeam will not let you comment. Tick "Remove restrictions" and copy again.' : "", failed: locked };
        }
        const res = await qpdfDecrypt(bytes);
        const after = await inspectSecurity(res.buffer);
        if (after.encrypted) throw new Error(`the PDF is still encrypted after unlocking (${res.flags})`);
        const what = sec.encrypted ? (sec.canAnnotate ? "This PDF was encrypted. The encryption was removed" : "Adding markups was restricted in this PDF. The restrictions were removed") : "This PDF carries a signature/certification seal. The seal restrictions were removed";
        return { bytes: res.buffer, note: `${what} from the working copy only (the document in SDx is unchanged). Method: qpdf ${res.flags}.`, unlocked: true };
    }

    /************************************************************
     * Revision check: does the Bluebeam PDF match the SDx document?
     ************************************************************/
    function viewerFrames() {
        return Array.from(document.querySelectorAll("iframe")).filter(f => /pdftron/i.test(f.getAttribute("src") || ""));
    }
    function sizesFromViewer() {
        for (const f of viewerFrames()) {
            let w;
            try { w = f.contentWindow; void w.document; } catch { continue; }
            const cores = [w.Core, w.instance && w.instance.Core, w.WebViewer && w.WebViewer.Core];
            for (const core of cores) {
                try {
                    if (!core) continue;
                    const dv = core.documentViewer || (core.getDocumentViewer && core.getDocumentViewer(1));
                    const d = dv && dv.getDocument && dv.getDocument();
                    if (!d) continue;
                    const n = d.getPageCount();
                    const sizes = [];
                    for (let i = 1; i <= n; i++) {
                        const info = d.getPageInfo(i);
                        if (!info || !info.width || !info.height) throw new Error("page info not ready");
                        sizes.push({ w: info.width, h: info.height });
                    }
                    if (sizes.length) return sizes;
                } catch {}
            }
        }
        return null;
    }
    function getViewerDoc() {
        for (const f of viewerFrames()) {
            let w;
            try { w = f.contentWindow; void w.document; } catch { continue; }
            for (const core of [w.Core, w.instance && w.instance.Core, w.WebViewer && w.WebViewer.Core]) {
                try {
                    const dv = core && (core.documentViewer || (core.getDocumentViewer && core.getDocumentViewer(1)));
                    const d = dv && dv.getDocument && dv.getDocument();
                    if (d) return { core, doc: d };
                } catch {}
            }
        }
        return null;
    }
    // Asks the viewer (PDFTron) to merge XFDF into the document and hand back a real PDF with proper appearances.
    async function embedXfdfViaViewer(xfdfString) {
        const v = getViewerDoc();
        if (!v || !v.doc.getFileData) throw new Error("the SDx viewer is not reachable from the script");
        const data = await v.doc.getFileData({ xfdfString });
        if (!data || !(data.byteLength || data.length)) throw new Error("the viewer returned no data");
        return toOwnBuffer(data);
    }
    // The viewer lives in an iframe, so its ArrayBuffer/Uint8Array are a different "realm":
    // "instanceof ArrayBuffer" is false for them. Copy the bytes into this window's own buffer.
    function toOwnBuffer(data) {
        const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        return view.slice().buffer;
    }
    async function collectExistingComments() {
        await loadLayers();
        const layers = [];
        for (const l of state.otherLayers) {
            try {
                const r = await api("/SDA/GetMarkupContent", { method: "POST", body: { MarkupOBID: l.id } });
                layers.push({ id: l.id, name: l.name, owner: l.owner, xml: typeof r === "object" ? r.value : String(r || "") });
            } catch (e) { warn("Could not read layer " + l.id, e); }
        }
        const built = buildExistingXfdf(layers);
        built.layerCount = layers.length;
        return built;
    }
    function findSdxPdfUrl() {
        // 1) WebViewer normally carries the document URL in the iframe hash (#d=...).
        for (const f of viewerFrames()) {
            try {
                const hash = new URL(f.src, location.href).hash.replace(/^#/, "");
                for (const part of hash.split("&")) {
                    const [k, ...rest] = part.split("=");
                    if (k === "d" && rest.length) {
                        const u = new URL(decodeURIComponent(rest.join("=")), location.origin).toString();
                        if (/\.pdf(\?|$)/i.test(u) || /SPFViewDir/i.test(u)) return u;
                    }
                }
            } catch {}
        }
        // 2) Resource timing entries (works when the request came from a window, not a worker).
        const wins = [window];
        for (const f of viewerFrames()) { try { void f.contentWindow.document; wins.push(f.contentWindow); } catch {} }
        let found = "";
        for (const w of wins) {
            try {
                for (const e of w.performance.getEntriesByType("resource")) {
                    if (/\/SPFViewDir\/.+\.pdf/i.test(e.name)) found = e.name;
                }
            } catch {}
        }
        return found;
    }
    async function sizesFromDownload() {
        const url = findSdxPdfUrl();
        if (!url) return null;
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) return null;
        const doc = await window.PDFLib.PDFDocument.load(await res.arrayBuffer(), { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
        return doc.getPages().map(pg => { const b = pg.getCropBox(); return { w: b.width, h: b.height }; });
    }
    async function getSdxPageSizes() {
        if (state.sdxPages && state.sdxPages.file === state.fileOBID && state.sdxPages.sizes) return state.sdxPages.sizes;
        let sizes = sizesFromViewer();
        if (!sizes) {
            try { sizes = await sizesFromDownload(); } catch (e) { warn("Could not download the SDx PDF for the revision check:", e); }
        }
        if (sizes) state.sdxPages = { file: state.fileOBID, sizes };
        return sizes;
    }
    async function runRevisionCheck() {
        if (!state.parsed) return;
        state.check = { status: "checking", message: "Checking that this PDF matches the SDx document..." };
        render();
        let result;
        try {
            result = comparePageSizes(state.parsed.pageSizes || [], await getSdxPageSizes());
            const nm = compareNames(state.parsed.fileName, currentDocName());
            if (!nm.ok) {
                result = {
                    status: "fail", nameMismatch: true,
                    message: nm.message + (result.status === "fail" || result.status === "warn" ? " " + result.message : "")
                };
            }
        } catch (e) {
            warn(e);
            result = { status: "unknown", message: "Revision check failed: " + e.message };
        }
        state.check = result;
        state.checkAck = false;
        log("Revision check:", result.status, result.message);
        render();
    }

    /************************************************************
     * Undo: remove comments this tool added to a layer
     ************************************************************/
    async function undoImport(layerId, mode) {
        const current = await api("/SDA/GetMarkupContent", { method: "POST", body: { MarkupOBID: layerId } });
        const existing = typeof current === "object" ? current.value : String(current || "");
        const r = removeImported(existing, mode);
        if (!r.removed) return { removed: 0 };
        const when = mode === "last" && r.latest ? new Date(r.latest).toLocaleString() : "";
        const ok = confirm(
            (mode === "last" ? `Undo the last import${when ? " (" + when + ")" : ""}?` : "Remove ALL comments imported by this tool from the layer?") +
            `\n\n${r.removed} comment(s) will be removed from this layer and the page will reload.\nAnything in the viewer that is not saved yet will be lost.`
        );
        if (!ok) return { removed: 0, cancelled: true };
        await api("/SDA/SaveMarkup", { method: "POST", body: { MarkupOBID: layerId, MarkupContent: r.xml, ...state.saveTemplate } });
        return { removed: r.removed };
    }
    async function onUndo(mode) {
        if (state.busy) return;
        const layerId = document.getElementById("sdxbmLayer").value;
        if (!layerId || layerId === "__new__") { setStatus("Pick an existing layer first.", true); return; }
        state.busy = true;
        try {
            setStatus("Looking for comments imported by this tool...");
            const r = await undoImport(layerId, mode);
            if (r.cancelled) { setStatus("Cancelled."); }
            else if (!r.removed) { setStatus("Nothing imported by this tool was found in that layer.", true); }
            else { setStatus(`Removed ${r.removed} comment(s). Reloading...`); setTimeout(() => location.reload(), 1500); return; }
        } catch (err) {
            warn(err);
            setStatus(err.message, true);
        }
        state.busy = false;
    }

    async function runImport(layerId, selectedAuthors, opts) {
        const me = await loadMe();
        let items = state.parsed.items.filter(it => selectedAuthors.has(it.a.T || "(no author)"));
        const sdxCount = state.sdxPages && state.sdxPages.file === state.fileOBID && state.sdxPages.sizes ? state.sdxPages.sizes.length : 0;
        const outOfRange = sdxCount ? items.filter(it => it.page >= sdxCount) : [];
        if (outOfRange.length) items = items.filter(it => it.page < sdxCount);
        const stamps = items.filter(it => it.a.Subtype === "Stamp" && it.ap);
        let n = 0;
        for (const it of stamps) {
            n++;
            setStatus(`Rendering snapshot/stamp ${n} of ${stamps.length}...`);
            try {
                it.imageData = it.imageData || await renderStampPng(state.parsed.doc, it, state.parsed.bytes);
            } catch (e) {
                warn("Stamp render failed:", e);
            }
        }
        const conv = convertAll(items, { author: me.userName, markupOBID: layerId, stampOpacity: state.stampOpacity });
        for (const it of outOfRange) conv.skipped.push({ page: it.page, type: it.a.Subtype || "?", subject: it.a.Subj || "", reason: "page does not exist in the SDx document" });
        let existing = "";
        if (!(opts && opts.isNew)) {
            const current = await api("/SDA/GetMarkupContent", { method: "POST", body: { MarkupOBID: layerId } });
            existing = typeof current === "object" ? current.value : String(current || "");
        }
        const merged = mergeIntoXfdf(existing, conv.items);
        if (!merged.added) return { added: 0, duplicates: merged.duplicates, skipped: conv.skipped };
        await api("/SDA/SaveMarkup", {
            method: "POST",
            body: { MarkupOBID: layerId, MarkupContent: merged.xml, ...state.saveTemplate }
        });
        return { added: merged.added, duplicates: merged.duplicates, skipped: conv.skipped, xml: merged.xml };
    }

    /************************************************************
     * UI
     ************************************************************/
    function viewerPresent() {
        return Boolean(document.querySelector('iframe[src*="/viewers/pdftron" i], iframe[src*="pdftron" i]'));
    }
    function installStyles() {
        if (document.getElementById(IDS.style)) return;
        const s = document.createElement("style");
        s.id = IDS.style;
        s.textContent = `
            #${IDS.btn}{position:fixed;left:214px;bottom:14px;z-index:999990;height:32px;padding:0 14px;border-radius:16px;border:1px solid #0f6cbd;
                background:linear-gradient(180deg,#0f6cbd,#075a9c);color:#fff;font:700 12px "Segoe UI",Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}
            #sdxbm_float_export{position:fixed;left:390px;bottom:14px;z-index:999990;height:32px;padding:0 14px;border-radius:16px;border:1px solid #0f6cbd;
                background:linear-gradient(180deg,#0f6cbd,#075a9c);color:#fff;font:700 12px "Segoe UI",Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}
            #${IDS.btn}:hover{background:linear-gradient(180deg,#1683df,#0f6cbd)}
            #${IDS.backdrop}{position:fixed;inset:0;background:rgba(0,0,0,.2);z-index:999998;display:none}
            #${IDS.modal}{position:fixed;top:70px;left:50%;transform:translateX(-50%);width:720px;max-width:calc(100vw - 40px);max-height:calc(100vh - 110px);
                z-index:999999;background:#fff;color:#242424;border-radius:10px;border:1px solid #c8d1dc;box-shadow:0 14px 40px rgba(0,0,0,.3);
                font-family:"Segoe UI",Arial,sans-serif;font-size:13px;display:none;overflow:hidden}
            #${IDS.backdrop}.open,#${IDS.modal}.open{display:block}
            #${IDS.modal} .hd{background:#005a9e;color:#fff;padding:11px 14px;display:flex;justify-content:space-between;align-items:center}
            #${IDS.modal} .hd b{font-size:15px} #${IDS.modal} .hd small{display:block;opacity:.85;font-size:11px;margin-top:2px}
            #${IDS.modal} .x{border:0;background:rgba(255,255,255,.2);color:#fff;border-radius:5px;padding:5px 9px;cursor:pointer;font-weight:700}
            #${IDS.modal} .docbar{padding:6px 14px;background:#eef4fb;border-bottom:1px solid #d7dee7;font-size:12px;color:#37506b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            #${IDS.modal} .tabs{display:flex;background:#f3f7fb;border-bottom:1px solid #d7dee7}
            #${IDS.modal} .tabs button{border:0;background:transparent;padding:9px 16px;font:700 13px "Segoe UI",Arial,sans-serif;color:#37506b;cursor:pointer;border-bottom:3px solid transparent}
            #${IDS.modal} .tabs button.active{background:#fff;color:#005a9e;border-bottom-color:#0078d4}
            #${IDS.modal} .bd{padding:12px 14px;overflow:auto;max-height:calc(100vh - 230px)}
            #${IDS.modal} .step{margin-bottom:10px;padding:8px 10px;border:2px solid transparent;border-radius:6px} #${IDS.modal} .step.cur{border-color:#d13438} #${IDS.modal} .step h4{margin:0 0 6px;font-size:13px}
            #${IDS.modal} .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
            #${IDS.modal} button.b{border:1px solid #b9c5d0;background:#fff;border-radius:6px;padding:6px 12px;cursor:pointer;font-weight:700;font-size:12px}
            #${IDS.modal} button.b.p{background:#0078d4;border-color:#0078d4;color:#fff}
            #${IDS.modal} button.b:disabled{opacity:.5;cursor:not-allowed}
            #${IDS.modal} select{height:32px;border:1px solid #b9c5d0;border-radius:6px;padding:0 8px;min-width:340px;max-width:100%}
            #${IDS.modal} table{border-collapse:collapse;width:100%;font-size:12px} #${IDS.modal} td,#${IDS.modal} th{border-bottom:1px solid #edf0f4;padding:3px 6px;text-align:left}
            #${IDS.modal} .note{background:#fff4ce;border:1px solid #ffb900;padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:10px}
            #${IDS.modal} .ok{background:#dff6dd;border:1px solid #57a64a;padding:8px 10px;border-radius:6px;font-size:12px}
            #${IDS.modal} .drop{border:2px dashed #9fb8d1;border-radius:8px;padding:22px 12px;text-align:center;color:#37506b;background:#f6f9fd;cursor:pointer;font-size:13px}
            #${IDS.modal} .drop.over{border-color:#0078d4;background:#e3f1fd}
            #${IDS.modal} .chk{padding:7px 10px;border-radius:6px;font-size:12px;border:1px solid #d2e5f5;background:#edf5fc}
            #${IDS.modal} .chk.ok{background:#dff6dd;border-color:#57a64a}
            #${IDS.modal} .chk.warn,#${IDS.modal} .chk.unknown{background:#fff4ce;border-color:#ffb900}
            #${IDS.modal} .chk.fail{background:#fde7e9;border-color:#d13438}
            @keyframes sdxbmGlow{0%,100%{box-shadow:0 0 4px 1px rgba(209,52,56,.45)}50%{box-shadow:0 0 14px 5px rgba(209,52,56,.9)}}
            #${IDS.modal} .chk.glow{border-width:2px;animation:sdxbmGlow 1.4s ease-in-out infinite}
            @media (prefers-reduced-motion:reduce){#${IDS.modal} .chk.glow{animation:none;box-shadow:0 0 10px 3px rgba(209,52,56,.8)}}
            #${IDS.modal} .ft{padding:9px 14px;border-top:1px solid #d7dee7;background:#f7f9fc;font-size:12px}
            #${IDS.modal} .ft.warn{background:#fff4ce}
            #${IDS.modal} .pill{font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.25)}
            #${IDS.modal} .pill.ok2{background:#dff6dd;color:#0e5c1f}
        `;
        document.head.appendChild(s);
    }
    const TOOLBAR_BTN_ID = "sdxbm_toolbar_btn";
    function findToolbarContainer() {
        try {
            for (const f of document.querySelectorAll("iframe")) {
                if (!/pdftron/i.test(f.getAttribute("src") || "")) continue;
                const doc = f.contentDocument;
                const c = doc && doc.querySelector(".custom-ribbons-container");
                if (c) return c;
            }
        } catch {}
        return null;
    }
    const BUTTONS = [
        { id: "sdxbm_toolbar_export", floatId: "sdxbm_float_export", view: "export", label: "Export to Bluebeam", title: "Copy this PDF to a working folder so you can mark it up in Bluebeam" },
        { id: TOOLBAR_BTN_ID, floatId: IDS.btn, view: "import", label: "Import Bluebeam", title: "Import markups from a Bluebeam-marked PDF into your SDx markup layer" }
    ];
    function buttonLabel(def) {
        const dot = def.view === "import" && state.work.savedAt ? " •" : "";
        return `${ICON} ${def.label}${dot}`;
    }
    function buildButton(doc, inline, def) {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = buttonLabel(def);
        b.title = def.title;
        b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openModal(def.view); });
        if (inline) {
            const margin = def.view === "export" ? "0 8px 0 auto" : "0 10px 0 0";
            b.style.cssText = `height:28px;padding:0 12px;margin:${margin};border-radius:14px;border:1px solid #0f6cbd;background:#0f6cbd;color:#fff;font:700 12px 'Segoe UI',Arial,sans-serif;cursor:pointer;white-space:nowrap;flex:0 0 auto;`;
        }
        return b;
    }
    function ensureButton() {
        if (viewerPresent()) syncDocument();
        if (!viewerPresent()) {
            for (const def of BUTTONS) document.getElementById(def.floatId)?.remove();
            return;
        }
        const container = findToolbarContainer();
        if (container) {
            for (const def of BUTTONS) document.getElementById(def.floatId)?.remove();
            if (getComputedStyle(container).display !== "flex") {
                container.style.display = "flex";
                container.style.alignItems = "center";
                container.style.justifyContent = "flex-end";
                container.style.flex = "1 1 auto";
            }
            for (const def of BUTTONS) {
                let b = container.querySelector("#" + def.id);
                if (!b) {
                    b = buildButton(container.ownerDocument, true, def);
                    b.id = def.id;
                    container.appendChild(b);
                }
                const label = buttonLabel(def);
                if (b.textContent !== label) b.textContent = label;
            }
            return;
        }
        // Fallback: viewer toolbar not found, keep floating buttons.
        installStyles();
        for (const def of BUTTONS) {
            let b = document.getElementById(def.floatId);
            if (!b) {
                b = buildButton(document, false, def);
                b.id = def.floatId;
                document.body.appendChild(b);
            }
            const label = buttonLabel(def);
            if (b.textContent !== label) b.textContent = label;
        }
    }
    /************************************************************
     * Export to Bluebeam (stage 1): copy the SDx PDF to a working folder,
     * watch it for a save, then hand it to the import step.
     ************************************************************/
    function idbOpen() {
        return new Promise((resolve, reject) => {
            const r = indexedDB.open("sdxbm", 1);
            r.onupgradeneeded = () => r.result.createObjectStore("kv");
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }
    async function idbGet(key) {
        const db = await idbOpen();
        return new Promise((resolve, reject) => {
            const q = db.transaction("kv").objectStore("kv").get(key);
            q.onsuccess = () => resolve(q.result);
            q.onerror = () => reject(q.error);
        });
    }
    async function idbSet(key, val) {
        const db = await idbOpen();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("kv", "readwrite");
            tx.objectStore("kv").put(val, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    async function loadWorkDir() {
        if (state.work.dir) return;
        try {
            const h = await idbGet("workDir");
            if (h) { state.work.dir = h; state.work.dirName = h.name; }
        } catch (e) { warn("Could not restore working folder:", e); }
    }
    async function ensureReadWrite(handle) {
        const opts = { mode: "readwrite" };
        if ((await handle.queryPermission(opts)) === "granted") return true;
        return (await handle.requestPermission(opts)) === "granted";
    }
    async function chooseWorkDir() {
        try {
            const h = await window.showDirectoryPicker({ id: "sdxbm-work", mode: "readwrite", startIn: "documents" });
            state.work.dir = h;
            state.work.dirName = h.name;
            await idbSet("workDir", h);
            setStatus(`Working folder set to "${h.name}".`);
        } catch (e) {
            if (e && e.name !== "AbortError") { warn(e); setStatus("Could not use that folder: " + e.message, true); }
        }
        render();
    }
    function safeFileBase(name) {
        const base = String(name || "SDx_document").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
        return (base || "SDx_document").slice(0, 120);
    }
    async function getSdxPdf() {
        const url = findSdxPdfUrl();
        if (url) {
            try {
                let res = await fetch(url, { credentials: "include" });
                if (res.status === 401 || res.status === 403) {
                    res = await fetch(url, { credentials: "include", headers: { authorization: getBestAuthorization() } });
                }
                if (res.ok) {
                    const seg = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
                    return { bytes: await res.arrayBuffer(), name: safeFileBase(seg) };
                }
                warn("SDx PDF download returned HTTP " + res.status);
            } catch (e) { warn("SDx PDF download failed:", e); }
        }
        // Fallback: ask the viewer for the file data it already loaded.
        for (const f of viewerFrames()) {
            let w;
            try { w = f.contentWindow; void w.document; } catch { continue; }
            for (const core of [w.Core, w.instance && w.instance.Core]) {
                try {
                    const dv = core && (core.documentViewer || (core.getDocumentViewer && core.getDocumentViewer(1)));
                    const d = dv && dv.getDocument && dv.getDocument();
                    if (!d || !d.getFileData) continue;
                    const data = await d.getFileData({});
                    if (data && (data.byteLength || data.length)) {
                        const buf = toOwnBuffer(data);
                        return { bytes: buf, name: safeFileBase(d.getFilename && d.getFilename()) };
                    }
                } catch {}
            }
        }
        throw new Error("Could not find the PDF behind the viewer. Use your own local copy and drop it into the Import tab instead.");
    }
    function stampForName() {
        const d = new Date(), z = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
    }
    async function exportToWorkFolder() {
        const w = state.work;
        if (state.busy) return;
        if (!w.dir) { setStatus("Choose a working folder first.", true); return; }
        state.busy = true;
        try {
            if (!(await ensureReadWrite(w.dir))) throw new Error("Folder access was not granted.");
            setStatus("Getting the PDF from SDx...");
            const pdf = await getSdxPdf();
            w.existing = null; w.existingNote = "";
            if (w.includeExisting) {
                try {
                    setStatus("Reading other reviewers' comments...");
                    const ex = await collectExistingComments();
                    if (ex.count) {
                        w.existing = ex.summary;
                        try {
                            setStatus(`Embedding ${ex.count} existing comment(s)...`);
                            pdf.bytes = await embedXfdfViaViewer(ex.xml);
                            w.existingNote = `Embedded ${ex.count} comment(s) from ${ex.layerCount} other layer(s) as locked markups in the copy. They are ignored when you import.`;
                        } catch (e) {
                            warn("Embedding existing comments failed:", e);
                            w.existingNote = `Found ${ex.count} comment(s) from other reviewers but could not embed them in the PDF (${e.message}). They are listed below instead.`;
                        }
                    } else {
                        w.existingNote = "No comments from other reviewers on this document.";
                    }
                } catch (e) {
                    warn("Could not read existing comments:", e);
                    w.existingNote = "Could not read other reviewers' comments: " + e.message;
                }
            }
            w.unlockNote = "";
            try {
                setStatus("Checking the PDF's security settings...");
                const u = await unlockIfNeeded(pdf.bytes, w.unlock);
                pdf.bytes = u.bytes;
                w.unlockNote = u.note;
            } catch (e) {
                warn("PDF unlock step failed:", e);
                w.unlockNote = "Could not check/remove the PDF's restrictions: " + e.message;
            }
            const name = `${pdf.name}_${stampForName()}.pdf`;
            const fh = await w.dir.getFileHandle(name, { create: true });
            const wr = await fh.createWritable();
            await wr.write(pdf.bytes);
            await wr.close();
            const f = await fh.getFile();
            Object.assign(w, { fileHandle: fh, fileName: name, baseline: f.lastModified, lastSeen: f.lastModified, stable: 0, savedAt: 0, notified: 0 });
            startWatch();
            checkOldFiles(false);
            setStatus(`Saved ${name}. Open it in Bluebeam, add comments, and save.`);
        } catch (e) {
            warn(e);
            setStatus(e.message, true);
        }
        state.busy = false;
        render();
    }
    function startWatch() {
        if (state.work.timer) clearInterval(state.work.timer);
        state.work.timer = setInterval(() => { if (!document.hidden) pollWork(); }, 10000);
    }
    async function pollWork() {
        const w = state.work;
        if (!w.fileHandle) return;
        try {
            const f = await w.fileHandle.getFile();
            if (f.lastModified !== w.lastSeen) { w.lastSeen = f.lastModified; w.stable = 0; return; }
            if (f.lastModified > w.baseline && w.notified !== f.lastModified) {
                w.stable++;
                if (w.stable >= 1) {
                    w.notified = f.lastModified;
                    w.savedAt = f.lastModified;
                    log("Bluebeam saved the working file.");
                    if (w.auto) importFromWork(); else if (isModalOpen() && state.view === "export") render();
                }
            }
        } catch { /* file may be locked mid-save; try again next tick */ }
    }
    function isModalOpen() {
        return Boolean(document.getElementById(IDS.modal)?.classList.contains("open"));
    }
    // Manual check: the user says they saved, so don't wait for the stability delay.
    async function checkWorkNow() {
        const w = state.work;
        if (!w.fileHandle) return;
        try {
            const f = await w.fileHandle.getFile();
            w.lastSeen = f.lastModified;
            if (f.lastModified > w.baseline) {
                w.notified = f.lastModified;
                w.savedAt = f.lastModified;
                setStatus(`Saved copy found (modified ${new Date(f.lastModified).toLocaleTimeString()}). Ready to import.`);
            } else {
                setStatus(`No save detected yet - the file has not changed since it was copied at ${new Date(w.baseline).toLocaleTimeString()}. Save in Bluebeam (Ctrl+S) and check again.`, true);
            }
        } catch (e) {
            setStatus("Could not read the working file (Bluebeam may be saving it). Try again in a moment.", true);
        }
        if (state.view === "export") render();
    }
    async function importFromWork() {
        const w = state.work;
        if (!w.fileHandle) return;
        let file = null;
        for (let i = 0; i < 4 && !file; i++) {
            try { file = await w.fileHandle.getFile(); } catch { await new Promise(r => setTimeout(r, 800)); }
        }
        if (!file) { setStatus("Could not read the working file (Bluebeam may still be saving). Try again in a moment.", true); return; }
        w.savedAt = 0;
        if (!isModalOpen()) openModal("import");
        state.view = "import";
        render();
        if (!state.layers.length) refreshLayers();
        await handleFile(file);
    }
    function renderExport(body) {
        const w = state.work;
        const fsa = typeof window.showDirectoryPicker === "function";
        const saved = w.savedAt ? new Date(w.savedAt).toLocaleTimeString() : "";
        const cs = cleanupSettings();
        const cur = !w.dirName ? 1 : (!w.fileName ? 2 : 3);
        let oldHtml = "";
        if (w.old && w.old.length) {
            const mb = (w.old.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1);
            const list = w.old.slice(0, 8).map(f => `<div>${esc(f.name)} <span style="color:#666">(${new Date(f.mtime).toLocaleDateString()})</span></div>`).join("") + (w.old.length > 8 ? `<div>...and ${w.old.length - 8} more</div>` : "");
            oldHtml = `<div class="note"><b>${w.old.length} exported file(s) (${mb} MB) are older than ${cs.days} days.</b> Delete them?
                <div style="margin:6px 0;font-size:12px">${list}</div>
                <button type="button" class="b p" id="sdxbmDelOld">Delete ${w.old.length} old file(s)</button>
                <button type="button" class="b" id="sdxbmKeepOld">Not now</button></div>`;
        } else if (w.oldChecked) {
            oldHtml = `<div class="chk ok" style="margin-bottom:8px">&#10003; No exported files older than ${cs.days} days.</div>`;
        } else if (w.oldNote) {
            oldHtml = `<div class="chk unknown" style="margin-bottom:8px">${esc(w.oldNote)}</div>`;
        }
        body.innerHTML = `
            ${fsa ? "" : '<div class="note">This browser does not support folder access. Use Edge or Chrome.</div>'}
            <div class="note">Copies the PDF you are viewing in SDx into a working folder. Open it in Bluebeam, add your comments, then <b>save</b> (Ctrl+S). This tool cannot launch Bluebeam or see when you close the file, so it watches for the save instead.</div>
            <div class="step ${cur === 1 ? "cur" : ""}"><h4>1. Working folder</h4>
                <div class="row"><span>${w.dirName ? "<b>" + esc(w.dirName) + "</b>" : "Not chosen yet"}</span>
                <button type="button" class="b" id="sdxbmPickDir" ${fsa ? "" : "disabled"}>${w.dirName ? "Change folder" : "Choose folder"}</button></div>
                <div class="row" style="margin-top:8px"><label style="font-size:12px">Full folder path:
                    <input type="text" id="sdxbmPath" value="${esc(w.path)}" placeholder="C:\\Users\\you\\Documents\\SDx Bluebeam" style="width:340px;height:28px;border:1px solid #b9c5d0;border-radius:6px;padding:0 8px"></label></div>
                <div style="font-size:12px;color:#666;margin-top:4px">Edge only tells this script the folder's <i>name</i>, never its location. Open the folder in Explorer, click the address bar, press Ctrl+C, and paste it here once. It is remembered and used by <b>Copy file path</b> in step 3.</div></div>
            <div class="step ${cur === 2 ? "cur" : ""}"><h4>2. Copy the SDx PDF</h4>
                <div class="row"><button type="button" class="b p" id="sdxbmExportBtn" ${fsa && w.dirName ? "" : "disabled"}>Copy PDF to working folder</button></div>
                <div style="margin-top:8px"><label style="font-size:12px"><input type="checkbox" id="sdxbmUnlock" ${w.unlock ? "checked" : ""}> Remove restrictions (sealed/locked PDFs) from the working copy</label></div>
                <div style="margin-top:4px"><label style="font-size:12px"><input type="checkbox" id="sdxbmIncExisting" ${w.includeExisting ? "checked" : ""}> Include other reviewers' existing comments in the copy (locked, so you can see what is already marked)</label></div>
                ${w.existingNote ? `<div class="chk ${/could not/i.test(w.existingNote) ? "warn" : "ok"}" style="margin-top:8px">${esc(w.existingNote)}</div>` : ""}
                ${w.existing && w.existing.length ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px">Existing comments (${w.existing.length})</summary>
                    <div style="max-height:200px;overflow:auto"><table><tr><th>Page</th><th>Author</th><th>Type</th><th>Comment</th></tr>${w.existing.slice(0, 300).map(c => `<tr><td>${c.page}</td><td>${esc(c.author)}</td><td>${esc(c.subject || c.type)}</td><td>${esc(c.text.slice(0, 160))}</td></tr>`).join("")}</table></div></details>` : ""}
                ${w.unlockNote ? `<div class="chk ${/^WARNING|could not|needs a password/i.test(w.unlockNote) ? "warn" : "ok"}" style="margin-top:8px">${esc(w.unlockNote)}</div>` : ""}
                ${w.fileName ? `<div class="ok" style="margin-top:8px">Saved <b>${esc(w.fileName)}</b> in <b>${esc(w.dirName)}</b>. Open it in Bluebeam (double-click it in that folder).</div>` : ""}</div>
            <div class="step ${cur === 3 ? "cur" : ""}"><h4>3. Comment in Bluebeam, save, then import</h4>
                <div class="chk ${w.savedAt ? "ok" : "unknown"}">${w.savedAt ? `&#10003; Bluebeam saved the file at ${esc(saved)}. Ready to import.` : (w.fileName ? "Waiting for you to save in Bluebeam... (checked every 10 seconds, or click Check for saved file now)" : "Waiting for step 2.")}</div>
                <div class="row" style="margin-top:8px"><button type="button" class="b" id="sdxbmCheckNow" ${w.fileName ? "" : "disabled"}>Check for saved file now</button>
                <button type="button" class="b p" id="sdxbmImportWork" ${w.fileName ? "" : "disabled"}>Import saved comments</button>
                <label style="font-size:12px"><input type="checkbox" id="sdxbmAuto" ${w.auto ? "checked" : ""}> Switch to the import step automatically when Bluebeam saves</label></div>
                ${w.fileName ? `<div class="row" style="margin-top:10px">
                    <button type="button" class="b" id="sdxbmCopyPath">Copy file path</button>
                    <button type="button" class="b" id="sdxbmCopyName">Copy file name</button></div>
                    <div style="font-size:12px;color:#666;margin-top:4px">A browser script cannot open Explorer for you. Click <b>Copy file path</b>, press <b>Win+R</b>, paste, and press Enter to open the file in Bluebeam.</div>` : ""}</div>
            <div class="step"><h4>4. Folder housekeeping</h4>
                ${oldHtml}
                <div class="row"><label style="font-size:12px">Offer to delete exported files older than
                    <input type="number" id="sdxbmDays" min="1" max="365" value="${cs.days}" style="width:60px;height:28px;border:1px solid #b9c5d0;border-radius:6px;padding:0 6px"> days</label>
                    <label style="font-size:12px"><input type="checkbox" id="sdxbmCleanAuto" ${cs.auto ? "checked" : ""}> Check automatically</label>
                    <button type="button" class="b" id="sdxbmCheckOld" ${w.dir ? "" : "disabled"}>Check now</button></div>
                <div style="font-size:12px;color:#666;margin-top:4px">Only files this tool created (names ending _YYYYMMDD-HHMMSS.pdf) are ever listed or deleted.</div></div>`;
        document.getElementById("sdxbmPickDir").addEventListener("click", chooseWorkDir);
        document.getElementById("sdxbmExportBtn").addEventListener("click", exportToWorkFolder);
        document.getElementById("sdxbmImportWork").addEventListener("click", importFromWork);
        document.getElementById("sdxbmCheckNow").addEventListener("click", checkWorkNow);
        document.getElementById("sdxbmAuto").addEventListener("change", e => { w.auto = e.target.checked; });
        document.getElementById("sdxbmIncExisting")?.addEventListener("change", e => { w.includeExisting = e.target.checked; writeJson("sdxbm_include_existing", w.includeExisting); });
        document.getElementById("sdxbmUnlock")?.addEventListener("change", e => { w.unlock = e.target.checked; writeJson("sdxbm_unlock", w.unlock); });
        document.getElementById("sdxbmPath")?.addEventListener("input", e => { w.path = e.target.value.trim(); writeJson("sdxbm_work_path", w.path); });
        document.getElementById("sdxbmCopyPath")?.addEventListener("click", copyFilePath);
        document.getElementById("sdxbmCopyName")?.addEventListener("click", () => copyText(w.fileName, "File name copied."));
        document.getElementById("sdxbmDays")?.addEventListener("change", e => { writeJson("sdxbm_cleanup_days", Math.min(365, Math.max(1, Number(e.target.value) || 14))); });
        document.getElementById("sdxbmCleanAuto")?.addEventListener("change", e => { writeJson("sdxbm_cleanup_auto", e.target.checked); });
        document.getElementById("sdxbmCheckOld")?.addEventListener("click", () => checkOldFiles(true));
        document.getElementById("sdxbmDelOld")?.addEventListener("click", deleteOldFiles);
        document.getElementById("sdxbmKeepOld")?.addEventListener("click", () => { w.old = null; w.oldChecked = false; w.oldNote = "Skipped for now. Click Check now to look again."; render(); });
    }
    async function copyText(text, okMsg) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            const ta = document.createElement("textarea");
            ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand("copy"); } catch {}
            ta.remove();
        }
        setStatus(okMsg);
    }
    function copyFilePath() {
        const w = state.work;
        if (!w.fileName) return;
        if (!w.path) {
            const entered = window.prompt("Edge does not tell this script where the working folder is.\n\nOpen the folder in Explorer, click the address bar, press Ctrl+C, and paste the folder path here (it is remembered):", "");
            if (entered && entered.trim()) {
                w.path = entered.trim().replace(/^"|"$/g, "");
                writeJson("sdxbm_work_path", w.path);
                if (state.view === "export") render();
            } else {
                copyText(w.fileName, "No folder path entered - copied just the file name.");
                return;
            }
        }
        const sep = /[\\/]$/.test(w.path) ? "" : "\\";
        copyText(w.path + sep + w.fileName, "Full path copied. Press Win+R, paste, and press Enter to open it.");
    }

    /************************************************************
     * Folder housekeeping: offer to delete old exports (only files this tool created)
     ************************************************************/
    const EXPORT_NAME_RE = /_\d{8}-\d{6}\.pdf$/i;
    function cleanupSettings() {
        return { days: Math.min(365, Math.max(1, Number(readJson("sdxbm_cleanup_days", 14)) || 14)), auto: readJson("sdxbm_cleanup_auto", true) !== false };
    }
    async function checkOldFiles(gesture) {
        const w = state.work;
        if (!w.dir) return;
        try {
            const opts = { mode: "readwrite" };
            let perm = await w.dir.queryPermission(opts);
            if (perm !== "granted") {
                if (!gesture) { w.oldNote = 'Click "Check now" to let the tool look in the folder for old files.'; if (state.view === "export") render(); return; }
                perm = await w.dir.requestPermission(opts);
                if (perm !== "granted") return;
            }
            const cutoff = Date.now() - cleanupSettings().days * 86400000;
            const found = [];
            for await (const [name, handle] of w.dir.entries()) {
                if (handle.kind !== "file" || !EXPORT_NAME_RE.test(name) || name === w.fileName) continue;
                try {
                    const f = await handle.getFile();
                    if (f.lastModified < cutoff) found.push({ name, size: f.size, mtime: f.lastModified });
                } catch {}
            }
            found.sort((a, b) => a.mtime - b.mtime);
            w.old = found; w.oldChecked = true; w.oldNote = "";
        } catch (e) {
            warn("Old-file check failed:", e);
            w.oldNote = "Could not check the folder: " + e.message;
        }
        if (state.view === "export") render();
    }
    async function deleteOldFiles() {
        const w = state.work;
        if (!w.dir || !w.old || !w.old.length) return;
        if (!confirm(`Permanently delete ${w.old.length} exported PDF(s) older than ${cleanupSettings().days} days from "${w.dirName}"?\n\nThis cannot be undone.`)) return;
        let ok = 0; const failed = [];
        for (const f of w.old) {
            try { await w.dir.removeEntry(f.name); ok++; } catch (e) { failed.push(f.name); }
        }
        setStatus(`Deleted ${ok} file(s)${failed.length ? `; ${failed.length} could not be deleted (open in Bluebeam?)` : ""}.`, Boolean(failed.length));
        await checkOldFiles(true);
    }
    function setView(view) {
        state.view = view;
        render();
        if (view === "export") {
            loadWorkDir().then(() => {
                if (state.view !== "export") return;
                render();
                if (cleanupSettings().auto && !state.work.autoChecked && state.work.dir) { state.work.autoChecked = true; checkOldFiles(false); }
            });
        }
        else refreshLayers();
    }
    function setStatus(msg, warning) {
        const el = document.getElementById("sdxbmStatus");
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle("warn", Boolean(warning));
    }
    function updateModalSession() {
        const el = document.getElementById("sdxbmSession");
        if (!el) return;
        const ok = Boolean(getBestAuthorization());
        el.textContent = ok ? "Session captured" : "Session not captured yet";
        el.className = "pill" + (ok ? " ok2" : "");
    }
    function installModal() {
        if (document.getElementById(IDS.modal)) return;
        installStyles();
        const bd = document.createElement("div");
        bd.id = IDS.backdrop;
        bd.addEventListener("click", closeModal);
        const m = document.createElement("div");
        m.id = IDS.modal;
        m.innerHTML = `
            <div class="hd"><div><b>${ICON} ${TOOL}</b><small>v${VERSION} | imports into your own markup layer on this document</small></div>
                <div class="row"><span class="pill" id="sdxbmSession">Session not captured yet</span><button class="x" id="sdxbmClose" type="button">X</button></div></div>
            <div class="docbar" id="sdxbmDoc"></div>
            <div class="tabs"><button type="button" id="sdxbmTabExport">Export to Bluebeam</button><button type="button" id="sdxbmTabImport">Import from Bluebeam</button></div>
            <div class="bd" id="sdxbmBody"></div>
            <div class="ft" id="sdxbmStatus">Ready.</div>`;
        // A file dropped anywhere outside the drop zone must not make the browser navigate to the PDF.
        for (const el of [bd, m]) {
            el.addEventListener("dragover", e => e.preventDefault());
            el.addEventListener("drop", e => e.preventDefault());
        }
        document.body.appendChild(bd);
        document.body.appendChild(m);
        document.getElementById("sdxbmClose").addEventListener("click", closeModal);
        document.getElementById("sdxbmTabExport").addEventListener("click", () => setView("export"));
        document.getElementById("sdxbmTabImport").addEventListener("click", () => setView("import"));
    }
    function closeModal() {
        document.getElementById(IDS.backdrop)?.classList.remove("open");
        document.getElementById(IDS.modal)?.classList.remove("open");
    }
    function openModal(view) {
        installModal();
        document.getElementById(IDS.backdrop).classList.add("open");
        document.getElementById(IDS.modal).classList.add("open");
        updateModalSession();
        syncDocument();
        setView(view === "export" ? "export" : "import");
    }
    async function refreshLayers() {
        try {
            setStatus("Loading your markup layers for this document...");
            await loadLayers();
            setStatus(state.layers.length
                ? `Found ${state.layers.length} markup layer(s) you own on this document.`
                : "You have no markup layer on this document yet. Start a markup in SDx first (pick its type), then come back.", !state.layers.length);
        } catch (e) {
            setStatus(e.message, true);
        }
        render();
    }
    function choiceForOpts() {
        const c = getCreateContext();
        const canCreate = Boolean(state.fileOBID && c.markupContextOBID && c.renditionOBID);
        if (state.layerChoice && (state.layerChoice === "__new__" ? canCreate : state.layers.some(l => l.id === state.layerChoice))) return state.layerChoice;
        if (state.layers.length) return state.layers.some(l => l.id === state.lastMarkupOBID) ? state.lastMarkupOBID : state.layers[0].id;
        return canCreate ? "__new__" : "";
    }
    function render() {
        const body = document.getElementById("sdxbmBody");
        if (!body) return;
        const docBar = document.getElementById("sdxbmDoc");
        if (docBar) { const dn = currentDocName(); docBar.innerHTML = dn ? `Reviewing: <b>${esc(dn)}</b>` : "No document detected yet"; docBar.title = dn; }
        document.getElementById("sdxbmTabExport")?.classList.toggle("active", state.view === "export");
        document.getElementById("sdxbmTabImport")?.classList.toggle("active", state.view !== "export");
        if (state.view === "export") { renderExport(body); return; }
        const p = state.parsed;
        const layerOpts = state.layers.map(l => {
            const label = `${l.name}${l.type ? " - " + l.type : ""}${l.created ? " - " + new Date(l.created).toLocaleString() : ""}${l.locked ? " (locked)" : ""}`;
            const sel = l.id === choiceForOpts() ? "selected" : "";
            return `<option value="${esc(l.id)}" ${sel} ${l.locked ? "disabled" : ""}>${esc(label)}</option>`;
        }).join("");
        const ctxIds = getCreateContext();
        const canCreate = Boolean(state.fileOBID && ctxIds.markupContextOBID && ctxIds.renditionOBID);
        const choice = choiceForOpts();
        const newOpt = canCreate ? `<option value="__new__" ${choice === "__new__" ? "selected" : ""}>+ Create a new layer for this import</option>` : "";
        const co = state.createOpts;
        const newRow = choice === "__new__" ? `<div class="row" style="margin-top:8px">
            <label style="font-size:12px">Review type:
            <select id="sdxbmType" style="min-width:200px">${(co ? co.types : FALLBACK_TYPES).map(t => `<option value="${esc(t.id)}" ${t.id === state.newLayer.type ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
            ${co && co.groups.length > 1 ? `<label style="font-size:12px">Owning group: <select id="sdxbmGroup" style="min-width:160px">${co.groups.map(g => `<option value="${esc(g.id)}" ${g.id === state.newLayer.group ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>` : ""}
            <span style="color:#666;font-size:12px">A new layer is created for you when you import.</span></div>
            <div class="row" style="margin-top:8px"><label style="font-size:12px">Description (optional):
            <input type="text" id="sdxbmDesc" maxlength="200" value="${esc(state.newLayer.desc)}" placeholder="e.g. Structural review comments" style="width:340px;height:28px;border:1px solid #b9c5d0;border-radius:6px;padding:0 8px"></label></div>` : "";
        const stampCount = p ? p.items.filter(it => it.a.Subtype === "Stamp" && it.ap).length : 0;
        const chk = state.check;
        const blocked = blockedByCheck();
        let checkHtml = "";
        if (chk && chk.status === "fail" && !state.checkAck) {
            checkHtml = `<div class="chk fail glow" style="margin-top:8px"><b>&#9888; This may be the wrong PDF.</b><div style="margin-top:4px">${esc(chk.message)}</div>
                <div class="row" style="margin-top:10px"><button type="button" class="b p" id="sdxbmChkContinue">Continue, the uploaded PDF is the correct copy</button>
                <button type="button" class="b" id="sdxbmChkRemove">Remove uploaded file</button></div></div>`;
        } else if (chk && chk.status === "fail") {
            checkHtml = `<div class="chk warn" style="margin-top:8px">&#9888; ${esc(chk.message)} <i>You chose to continue with this file.</i></div>`;
        } else if (chk) {
            checkHtml = `<div class="chk ${esc(chk.status)}" style="margin-top:8px">${chk.status === "ok" ? "&#10003; " : chk.status === "checking" ? "" : "&#9888; "}${esc(chk.message)}${chk.status === "unknown" ? ' <button type="button" class="b" id="sdxbmRecheck" style="margin-left:6px">Re-check</button>' : ""}</div>`;
        }
        const curStep = !p || blocked ? 1 : (state.step2Done ? 3 : 2);
        const lr = state.lastResult;
        let resultHtml = "";
        if (lr && (lr.skipped.length || !lr.added)) {
            const rows = summarizeSkipped(lr.skipped).map(g => `<tr><td>${esc(g.type)}</td><td>${g.count}</td><td>${esc(formatPages(g.pages) || "-")}</td><td>${esc(g.reason)}</td></tr>`).join("");
            resultHtml = `<div class="chk ${lr.added ? "warn" : "fail"}" style="margin-bottom:12px">
                <b>${lr.added ? `Imported ${lr.added} comment(s), but ${lr.skipped.length} did not come in.` : `No comments were imported${lr.duplicates ? ` (${lr.duplicates} were already in the layer)` : ""}.`}</b>
                ${rows ? `<table style="margin-top:6px"><tr><th>Comment type</th><th>Count</th><th>Pages</th><th>Reason</th></tr>${rows}</table>` : ""}
                ${lr.added ? '<div style="margin-top:8px"><button type="button" class="b p" id="sdxbmReloadPage">Reload page to see the imported comments</button></div>' : ""}</div>`;
        }
        let preview = "";
        if (p) {
            const authorRows = Array.from(p.authors.entries()).map(([who, n]) =>
                `<tr><td><input type="checkbox" class="sdxbmAuthor" data-a="${esc(who)}" checked></td><td>${esc(who)}</td><td>${n}</td></tr>`).join("");
            preview = `
                <div class="ok">Read <b>${p.items.length}</b> annotation(s) on ${p.pageCount} page(s) from <b>${esc(p.fileName)}</b>.${p.existingSkipped ? ` ${p.existingSkipped} existing SDx comment(s) embedded at export were ignored.` : ""}
                    ${state.converted ? `Convertible: <b>${state.converted.items.length}</b>, not supported: <b>${state.converted.skipped.length}</b>.` : ""}</div>
                ${checkHtml}
                <table style="margin-top:8px"><tr><th></th><th>Bluebeam author</th><th>Annotations</th></tr>${authorRows}</table>
                ${state.converted && state.converted.skipped.length ? `<div class="note" style="margin-top:8px"><b>Skipped:</b> ${esc(Array.from(new Set(state.converted.skipped.map(s => `${s.type} (${s.reason})`))).join("; "))}</div>` : ""}`;
        }
        body.innerHTML = `
            <div class="note">The imported comments are saved under <b>your SDx identity</b> (${esc(state.me?.userName || "detected on load")}). The original Bluebeam author, name, subject and dates are kept in each comment's custom data and the original creation date is preserved. Re-importing the same PDF skips comments that are already in the layer.</div>
            ${resultHtml}
            <div class="step ${curStep === 1 ? "cur" : ""}"><h4>1. Drop the Bluebeam-marked PDF here</h4>
                <div id="sdxbmDrop" class="drop" tabindex="0">
                    <div>${p ? `<b>${esc(p.fileName)}</b><br>Drop another PDF to replace it, or click to browse` : "Drag and drop the PDF here, or click to browse"}</div>
                    <input type="file" id="sdxbmFile" accept="application/pdf,.pdf" style="display:none">
                </div>
                <div id="sdxbmPreview" style="margin-top:8px">${preview}</div></div>
            <div class="step ${curStep === 2 ? "cur" : ""}"><h4>2. Choose your markup layer</h4>
                <div class="row"><select id="sdxbmLayer">${newOpt}${layerOpts}${!newOpt && !layerOpts ? '<option value="">(no layers found)</option>' : ""}</select>
                <button type="button" class="b" id="sdxbmReloadLayers">Reload layers</button></div>
                ${newRow}
                <div class="row" style="margin-top:10px"><button type="button" class="b ${state.step2Done ? "" : "p"}" id="sdxbmStep2Ok" ${p && !blocked ? "" : "disabled"}>${state.step2Done ? "&#10003; Looks good" : "Looks good - continue"}</button>
                <span style="color:#666;font-size:12px">The defaults here are usually fine. Change them only if you need to.</span></div></div>
            ${stampCount ? `<div class="step"><h4>Snapshot / stamp opacity</h4>
                <div class="row"><input type="range" id="sdxbmOpacity" min="0" max="100" step="5" value="${Math.round(state.stampOpacity * 100)}" style="width:260px">
                <b id="sdxbmOpacityVal">${Math.round(state.stampOpacity * 100)}%</b>
                <span style="color:#666;font-size:12px">${stampCount} snapshot/stamp(s) found. 100% = fully opaque.</span></div></div>` : ""}
            <div class="step ${curStep === 3 ? "cur" : ""}"><h4>3. Import</h4>
                <div class="row"><button type="button" class="b p" id="sdxbmImport" ${p && !blocked && (state.layers.length || canCreate) ? "" : "disabled"}>Import into SDx layer</button>
                <button type="button" class="b" id="sdxbmDownload" ${state.converted ? "" : "disabled"}>Download XFDF (debug)</button></div>
                <div class="row" style="margin-top:8px"><button type="button" class="b" id="sdxbmUndo" ${state.layers.length ? "" : "disabled"} title="Remove the comments added by the most recent import into the selected layer">Undo last import</button>
                <button type="button" class="b" id="sdxbmRemoveAll" ${state.layers.length ? "" : "disabled"} title="Remove every comment this tool has ever added to the selected layer">Remove all imported</button></div></div>`;
        const drop = document.getElementById("sdxbmDrop");
        const fileInput = document.getElementById("sdxbmFile");
        fileInput.addEventListener("change", () => handleFile(fileInput.files && fileInput.files[0]));
        drop.addEventListener("click", () => fileInput.click());
        drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
        for (const evt of ["dragenter", "dragover"]) {
            drop.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); drop.classList.add("over"); });
        }
        for (const evt of ["dragleave", "dragend"]) {
            drop.addEventListener(evt, e => { e.preventDefault(); drop.classList.remove("over"); });
        }
        drop.addEventListener("drop", e => {
            e.preventDefault();
            e.stopPropagation();
            drop.classList.remove("over");
            const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []).find(x => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
            if (!f) { setStatus("That wasn't a PDF. Drop a .pdf file.", true); return; }
            handleFile(f);
        });
        document.getElementById("sdxbmReloadLayers").addEventListener("click", refreshLayers);
        document.getElementById("sdxbmLayer").addEventListener("change", e => { state.layerChoice = e.target.value; state.layerTouched = true; render(); });
        document.getElementById("sdxbmType")?.addEventListener("change", e => { state.newLayer.type = e.target.value; writeJson("sdxbm_layer_type", e.target.value); });
        document.getElementById("sdxbmDesc")?.addEventListener("input", e => { state.newLayer.desc = e.target.value; });
        document.getElementById("sdxbmStep2Ok")?.addEventListener("click", () => { state.step2Done = true; render(); });
        document.getElementById("sdxbmGroup")?.addEventListener("change", e => { state.newLayer.group = e.target.value; });
        document.getElementById("sdxbmReloadPage")?.addEventListener("click", () => location.reload());
        if (choice === "__new__" && !state.createOpts) loadCreateOptions().then(() => { if (state.view !== "export") render(); }).catch(e => warn(e));
        document.getElementById("sdxbmImport").addEventListener("click", onImport);
        const slider = document.getElementById("sdxbmOpacity");
        if (slider) {
            slider.addEventListener("input", () => {
                state.stampOpacity = Number(slider.value) / 100;
                document.getElementById("sdxbmOpacityVal").textContent = slider.value + "%";
                writeJson("sdxbm_stamp_opacity", state.stampOpacity);
            });
        }
        document.getElementById("sdxbmDownload").addEventListener("click", onDownload);
        document.getElementById("sdxbmUndo").addEventListener("click", () => onUndo("last"));
        document.getElementById("sdxbmRemoveAll").addEventListener("click", () => onUndo("all"));
        document.getElementById("sdxbmRecheck")?.addEventListener("click", () => { state.sdxPages = null; runRevisionCheck(); });
        document.getElementById("sdxbmChkContinue")?.addEventListener("click", () => { state.checkAck = true; setStatus("Continuing with the uploaded PDF. Pick your layer, then import."); render(); });
        document.getElementById("sdxbmChkRemove")?.addEventListener("click", () => {
            state.parsed = null; state.converted = null; state.check = null; state.checkAck = false; state.step2Done = false;
            setStatus("Uploaded file removed. Drop the correct PDF to continue.");
            render();
        });
    }
    function selectedAuthors() {
        const set = new Set();
        document.querySelectorAll(".sdxbmAuthor").forEach(cb => { if (cb.checked) set.add(cb.dataset.a); });
        return set;
    }
    async function handleFile(file) {
        if (!file) return;
        try {
            setStatus(`Reading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)...`);
            let buf = await file.arrayBuffer();
            try {
                const u = await unlockIfNeeded(buf, true);
                if (u.failed) throw new Error(u.note);
                buf = u.bytes;
            } catch (e) {
                if (/needs a password/i.test(e.message)) throw e;
                warn("Security check/unlock skipped:", e);
            }
            const parsed = await readBluebeamPdf(buf);
            parsed.fileName = file.name;
            parsed.bytes = buf;
            state.parsed = parsed;
            state.check = null;
            state.checkAck = false;
            state.layerTouched = false;
            state.step2Done = false;
            const me = await loadMe().catch(() => ({ userName: "SDX_USER" }));
            state.converted = convertAll(parsed.items, { author: me.userName, markupOBID: "PREVIEW", previewStamps: true });
            setStatus(parsed.items.length ? "PDF read. Pick the authors to include and your layer, then import." : "No annotations found in this PDF.", !parsed.items.length);
            render();
            runRevisionCheck();
            return;
        } catch (err) {
            warn(err);
            state.parsed = null; state.converted = null;
            setStatus("Could not read that PDF: " + err.message, true);
        }
        render();
    }
    function blockedByCheck() {
        const c = state.check;
        return Boolean(c && (c.status === "checking" || (c.status === "fail" && !state.checkAck)));
    }
    async function onImport() {
        if (state.busy) return;
        if (blockedByCheck()) { setStatus("Resolve the warning about the uploaded PDF first (continue with it, or remove it).", true); return; }
        let layerId = document.getElementById("sdxbmLayer").value;
        const authors = selectedAuthors();
        if (!layerId || !authors.size) { setStatus("Pick a layer (or create a new one) and at least one author.", true); return; }
        const isNew = layerId === "__new__";
        const chk = state.check;
        const warning = chk && (chk.status === "fail" || chk.status === "warn") ? `WARNING: ${chk.message}\n\n` : "";
        const typeName = isNew && state.createOpts ? (state.createOpts.types.find(t => t.id === state.newLayer.type) || {}).name : "";
        const what = isNew ? `This creates a new "${typeName || state.newLayer.type}" markup layer in SDx, writes the comments into it,` : "This writes the comments into your SDx markup layer";
        if (!confirm(warning + what + " and then reloads the page.\n\nAny markup you have drawn in the viewer but NOT yet saved will be lost. Continue?")) return;
        state.busy = true;
        document.getElementById("sdxbmImport").disabled = true;
        state.lastResult = null;
        try {
            if (isNew) {
                setStatus("Creating the new layer...");
                await loadCreateOptions();
                layerId = (await createLayer(state.newLayer.type, state.newLayer.group, state.newLayer.desc)).id;
                state.layerChoice = layerId;
            }
            setStatus("Importing...");
            const r = await runImport(layerId, authors, { isNew });
            state.lastResult = { added: r.added, duplicates: r.duplicates, skipped: r.skipped || [] };
            state.busy = false;
            if (!r.added) {
                setStatus(r.duplicates ? `Nothing new to import (${r.duplicates} already in the layer).` : "No comments were imported. See the summary above.", true);
                render();
                return;
            }
            if (r.skipped.length) {
                setStatus(`Imported ${r.added} comment(s). ${r.skipped.length} could not be imported - see the summary above. Reload the page when ready.`, true);
                render();
                return;
            }
            setStatus(`Imported ${r.added} comment(s)${r.duplicates ? `, skipped ${r.duplicates} already present` : ""}. Reloading...`);
            setTimeout(() => location.reload(), 1800);
        } catch (err) {
            warn(err);
            setStatus(err.message, true);
            state.busy = false;
            render();
        }
    }
    function onDownload() {
        if (!state.converted) return;
        const xml = mergeIntoXfdf("", state.converted.items).xml;
        const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
        const a = document.createElement("a");
        a.href = url; a.download = "bluebeam-import.xfdf";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    installHooks();
    setInterval(ensureButton, 1500);
    log("loaded");
})();
