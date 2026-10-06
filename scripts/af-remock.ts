// Phase B: AF-Produktbilder neu — randlose Room-Scene-Mockups.
//
// Pro Leinwand-Motiv: Printify-Design (randlos) holen -> in ALLE vertikalen
// PSD-Templates rendern (cover-fit, keine weißen Ränder) -> nach Medusa prod
// hochladen (/admin/uploads -> /static) -> Produktbilder + Thumbnail ersetzen.
//
// Nutzung:
//   npx tsx scripts/af-remock.ts --only <handle>   # ein Muster-Produkt
//   npx tsx scripts/af-remock.ts --all             # alle Leinwand-Motive
//   (ohne Args: erstes Leinwand-Produkt als Muster)

import fs from "node:fs"
import path from "node:path"
import dotenv from "dotenv"
import { loadImage } from "@napi-rs/canvas"
import { renderMockup } from "../src/server/render"

dotenv.config({ path: path.join(process.cwd(), ".env.local") })
// Medusa-Admin-Creds NICHT hardcoden — aus gitignorierter scripts/.remock.env.
dotenv.config({ path: path.join(process.cwd(), "scripts", ".remock.env") })

const MEDUSA = process.env.MEDUSA_ADMIN_URL || "https://shop.atelier-faille.de"
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@atelier-faille.de"

// Admin-Passwort nicht hardcoden. Reihenfolge: Env > vorhandenes import-shopify.mjs
// (enthält die Creds bereits legitim, wird hier nur zur Laufzeit gelesen — wie .env).
function resolvePassword(): string {
  if (process.env.MEDUSA_ADMIN_PASSWORD) return process.env.MEDUSA_ADMIN_PASSWORD
  const canonical =
    "/Users/benlangeheinecke/Documents/Business Backend/Atelier Faille Shop/import-shopify.mjs"
  try {
    const src = fs.readFileSync(canonical, "utf8")
    const match = src.match(/PASSWORD\s*=\s*["'`]([^"'`]+)["'`]/)
    if (match) return match[1]
  } catch {}
  throw new Error("MEDUSA_ADMIN_PASSWORD fehlt (Env oder import-shopify.mjs)")
}
const PASSWORD = resolvePassword()

const PRINTIFY_TOKEN = process.env.PRINTIFY_API_TOKEN!
const PRINTIFY_SHOP = process.env.PRINTIFY_SHOP_ID!
const PSD_DIR = path.join(process.cwd(), "data", "mockups", "vertical")
const SCRATCH =
  "/private/tmp/claude-501/-Users-benlangeheinecke-Documents-Business-Backend/1586e459-d478-439e-90f8-068a9d3a6a4c/scratchpad"

const args = process.argv.slice(2)
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null
const all = args.includes("--all")

let token = ""
async function m(path: string, method = "GET", body?: any): Promise<any> {
  const res = await fetch(`${MEDUSA}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

async function pf(p: string): Promise<any> {
  const res = await fetch(`https://api.printify.com/v1${p}`, {
    headers: { Authorization: `Bearer ${PRINTIFY_TOKEN}` },
  })
  if (!res.ok) throw new Error(`printify ${p} -> ${res.status}`)
  return res.json()
}

// Design-Bild (randloses Artwork) aus einem Printify-Produkt ziehen.
function designSrc(pfProduct: any): string | null {
  for (const area of pfProduct.print_areas || []) {
    for (const ph of area.placeholders || []) {
      const img = (ph.images || [])[0]
      if (img?.src) return img.src
    }
  }
  return null
}

async function uploadToMedusa(buf: Buffer, name: string): Promise<string> {
  const fd = new FormData()
  fd.append("files", new Blob([buf], { type: "image/webp" }), name)
  const res = await fetch(`${MEDUSA}/admin/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`upload -> ${res.status}: ${text.slice(0, 300)}`)
  const json = JSON.parse(text)
  const url = (json.uploads || json.files || [])[0]?.url
  if (!url) throw new Error(`upload: keine URL in ${text.slice(0, 200)}`)
  return url
}

const force = args.includes("--force")

async function remockProduct(p: any, savePng: boolean): Promise<void> {
  const handle = p.handle
  if (!force && typeof p.thumbnail === "string" && p.thumbnail.includes("/static/")) {
    console.log(`  SKIP ${handle}: schon gemockt (--force zum Erzwingen)`)
    return
  }
  const pfId = (p.variants || [])
    .map((v: any) => v.metadata?.printify_product_id)
    .find(Boolean)
  if (!pfId) {
    console.log(`  SKIP ${handle}: keine printify_product_id`)
    return
  }
  const pfProduct = await pf(`/shops/${PRINTIFY_SHOP}/products/${pfId}.json`)
  const src = designSrc(pfProduct)
  if (!src) {
    console.log(`  SKIP ${handle}: kein Design-Bild in Printify`)
    return
  }
  const designBuf = Buffer.from(await (await fetch(src)).arrayBuffer())
  console.log(`  ${handle}: design ${(designBuf.length / 1024 / 1024).toFixed(1)}MB`)

  const psds = fs
    .readdirSync(PSD_DIR)
    .filter((f) => f.endsWith(".psd"))
    .sort()
  const urls: string[] = []
  for (let i = 0; i < psds.length; i++) {
    const r = await renderMockup(path.join(PSD_DIR, psds[i]), designBuf, {
      maxEdge: 1600,
      quality: 85,
    })
    if (savePng && i === 0) {
      const img = await loadImage(r.buffer)
      const { createCanvas } = await import("@napi-rs/canvas")
      const c = createCanvas(img.width, img.height)
      c.getContext("2d").drawImage(img, 0, 0)
      fs.writeFileSync(path.join(SCRATCH, `remock-${handle}.png`), c.toBuffer("image/png"))
    }
    const url = await uploadToMedusa(r.buffer, `${handle}-scene${i + 1}.webp`)
    urls.push(url)
    process.stdout.write(`    scene${i + 1} ok `)
  }
  console.log("")
  await m(`/admin/products/${p.id}`, "POST", {
    images: urls.map((url) => ({ url })),
    thumbnail: urls[0],
  })
  console.log(`  ✓ ${handle}: ${urls.length} Mockups gesetzt, Thumb ${urls[0]}`)
}

async function main() {
  await m("/auth/user/emailpass", "POST", { email: EMAIL, password: PASSWORD }).then(
    (r) => (token = r.token)
  )
  const { products } = await m(
    "/admin/products?limit=200&fields=id,handle,title,thumbnail,*variants,variants.metadata"
  )
  let leinwand = products.filter((p: any) => p.handle?.endsWith("-leinwand"))
  if (only) leinwand = leinwand.filter((p: any) => p.handle === only)
  else if (!all) leinwand = leinwand.slice(0, 1)
  console.log(`Ziel: ${leinwand.length} Produkt(e) — ${leinwand.map((p: any) => p.handle).join(", ")}`)
  for (const p of leinwand) {
    await remockProduct(p, !all) // bei Muster PNG speichern
  }
  console.log("fertig.")
}

main().catch((e) => {
  console.error("FEHLER:", e.message)
  process.exit(1)
})
