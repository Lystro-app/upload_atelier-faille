// Legt aus einem fertigen Printify-Produkt + gerenderten Mockups ein Medusa-
// Produkt an (Draft). Spiegelt die bestehende Medusa-Katalogstruktur:
// Größe-Option + Preise aus data/pricing.json, printify-ids in Variant-Metadata.
//
// Admin password comes only from MEDUSA_ADMIN_PASSWORD. It is read when a
// Medusa request runs (after dotenv), not from a file on disk.

import fs from "node:fs";
import path from "node:path";

const MEDUSA = process.env.MEDUSA_ADMIN_URL || "https://shop.atelier-faille.de";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@atelier-faille.de";
const SALES_CHANNEL = "sc_01M394XDR6257TQWYZ5P5PC439";
const SHIPPING_PROFILE = "sp_01M394XCW4DR2BDD6DWJ9J06M7";
const PF_TOKEN = () => process.env.PRINTIFY_API_TOKEN!;
const PF_SHOP = () => process.env.PRINTIFY_SHOP_ID!;

function adminPassword(): string {
  const password = process.env.MEDUSA_ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      "MEDUSA_ADMIN_PASSWORD is not set. Set it in the environment before publishing to Medusa."
    );
  }
  return password;
}

let token = "";
async function md(p: string, method = "GET", body?: any): Promise<any> {
  const r = await fetch(`${MEDUSA}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`medusa ${method} ${p} ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

async function login(): Promise<void> {
  if (token) return;
  token = (await md("/auth/user/emailpass", "POST", { email: EMAIL, password: adminPassword() })).token;
  if (!token) throw new Error("Medusa-Login fehlgeschlagen");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// data/pricing.json -> Lookup je Zoll-Maß: {retail, cmLabel}
interface PriceInfo { retail: number; cmLabel: string; }
function loadPricing(type: "stretched" | "framed"): Map<string, PriceInfo> {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "pricing.json"), "utf8"));
  const map = new Map<string, PriceInfo>();
  for (const e of raw[type] as any[]) {
    const nums = String(e.label).match(/\d+/g) || [];
    const inchKey = nums.slice(0, 2).join("x"); // z.B. "12x18"
    const cm = String(e.label).match(/\(([^)]+)\)/)?.[1] || "";
    const cmLabel = cm.replace(/cm/i, "").replace(/×|x/i, " × ").trim() + " cm";
    map.set(inchKey, { retail: e.retail, cmLabel });
  }
  return map;
}

function inchKeyFromTitle(title: string): string {
  const nums = String(title).match(/\d+/g) || [];
  return nums.slice(0, 2).join("x");
}

async function getCollectionId(handle: string, title: string): Promise<string> {
  const list = await md(`/admin/collections?handle=${handle}`);
  if (list.collections?.[0]) return list.collections[0].id;
  const r = await md("/admin/collections", "POST", { title, handle });
  return r.collection.id;
}

async function uploadMockups(mockups: { dataUrl: string; filename: string }[]): Promise<string[]> {
  const urls: string[] = [];
  for (const mk of mockups) {
    const b64 = mk.dataUrl.replace(/^data:.+?;base64,/, "");
    const buf = Buffer.from(b64, "base64");
    const fd = new FormData();
    fd.append("files", new Blob([buf], { type: "image/webp" }), mk.filename);
    const r = await fetch(`${MEDUSA}/admin/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`upload ${r.status}: ${t.slice(0, 200)}`);
    const url = (JSON.parse(t).uploads || JSON.parse(t).files || [])[0]?.url;
    if (url) urls.push(url);
  }
  return urls;
}

export interface MedusaResult { productId: string; variants: number; images: number; handle: string; }

// Hauptfunktion: Printify-Produkt -> Medusa-Draft-Produkt.
export async function createMedusaProductFromPrintify(args: {
  type: "stretched" | "framed";
  title: string;        // Basistitel ohne Suffix
  description?: string;
  printifyId: string;
  mockups: { dataUrl: string; filename: string }[];
}): Promise<MedusaResult> {
  await login();
  const suffix = args.type === "stretched" ? "Leinwand" : "Gerahmt";
  const fullTitle = `${args.title} — ${suffix}`;
  const handle = `${slugify(args.title)}-${args.type === "stretched" ? "leinwand" : "gerahmt"}`;

  // Printify-Produkt holen (Optionen + enabled Varianten)
  const pf = await (await fetch(
    `https://api.printify.com/v1/shops/${PF_SHOP()}/products/${args.printifyId}.json`,
    { headers: { Authorization: `Bearer ${PF_TOKEN()}` } }
  )).json() as any;

  const pricing = loadPricing(args.type);
  const pfOptions: any[] = pf.options || [];
  const sizeOpt = pfOptions.find((o) => o.type === "size") || pfOptions[0];

  // value-id -> Anzeigetitel (Größe: cm-Label; sonst Printify-Titel)
  const valueTitle = (optId: number, valId: number): string => {
    const opt = pfOptions.find((o: any) => o.values?.some((v: any) => v.id === valId));
    const v = opt?.values?.find((x: any) => x.id === valId);
    const raw = v?.title || String(valId);
    if (opt === sizeOpt) {
      const info = pricing.get(inchKeyFromTitle(raw));
      return info?.cmLabel || raw;
    }
    return raw;
  };
  const optTitle = (o: any): string => (o === sizeOpt ? "Größe" : o.name);

  const enabled = (pf.variants || []).filter((v: any) => v.is_enabled);
  if (!enabled.length) throw new Error("Printify-Produkt hat keine enabled Varianten");

  // Medusa-Produkt-Optionen: pro Printify-Option die vorkommenden Anzeigewerte
  const options = pfOptions.map((o: any) => {
    const vals = new Set<string>();
    for (const v of enabled) {
      const idx = pfOptions.indexOf(o);
      vals.add(valueTitle(o.id, v.options[idx]));
    }
    return { title: optTitle(o), values: [...vals] };
  });

  // Varianten
  const variants = enabled.map((v: any) => {
    const optionObj: Record<string, string> = {};
    pfOptions.forEach((o: any, idx: number) => {
      optionObj[optTitle(o)] = valueTitle(o.id, v.options[idx]);
    });
    const sizeIdx = pfOptions.indexOf(sizeOpt);
    const sizeRaw = sizeOpt.values.find((x: any) => x.id === v.options[sizeIdx])?.title || "";
    const retail = pricing.get(inchKeyFromTitle(sizeRaw))?.retail;
    return {
      title: v.title,
      sku: v.sku,
      manage_inventory: false,
      allow_backorder: false,
      prices: [{ amount: retail ?? Math.round(v.price / 100), currency_code: "eur" }],
      options: optionObj,
      metadata: { printify_product_id: args.printifyId, printify_variant_id: String(v.id) },
    };
  });

  const imageUrls = await uploadMockups(args.mockups);
  const collectionId = await getCollectionId(
    args.type === "stretched" ? "leinwand-editionen" : "gerahmte-editionen",
    args.type === "stretched" ? "Leinwand-Editionen" : "Gerahmte Editionen"
  );

  const payload: any = {
    title: fullTitle,
    handle,
    description: args.description || `<p>${fullTitle}</p>`,
    status: "draft",
    options,
    variants,
    images: imageUrls.map((url) => ({ url })),
    thumbnail: imageUrls[0],
    collection_id: collectionId,
    shipping_profile_id: SHIPPING_PROFILE,
    sales_channels: [{ id: SALES_CHANNEL }],
  };
  const r = await md("/admin/products", "POST", payload);
  return { productId: r.product.id, variants: variants.length, images: imageUrls.length, handle };
}
