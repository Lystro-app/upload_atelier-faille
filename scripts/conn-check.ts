// Prüft alle externen API-Connections des Upload-Programms. Keine Secrets im Output.
import path from "node:path"
import dotenv from "dotenv"
import { driveConfigured, driveListImages } from "../src/server/drive"
dotenv.config({ path: path.join(process.cwd(), ".env.local") })

const ok = (s: string) => console.log(`  OK    ${s}`)
const fail = (s: string) => console.log(`  FAIL  ${s}`)

async function printify() {
  try {
    const t = process.env.PRINTIFY_API_TOKEN
    const shop = process.env.PRINTIFY_SHOP_ID
    if (!t) return fail("Printify: PRINTIFY_API_TOKEN fehlt")
    const r = await fetch("https://api.printify.com/v1/shops.json", {
      headers: { Authorization: `Bearer ${t}` },
    })
    if (!r.ok) return fail(`Printify: HTTP ${r.status}`)
    const shops = await r.json()
    const hit = (shops as any[]).find((s) => String(s.id) === String(shop))
    ok(`Printify: ${(shops as any[]).length} Shop(s), Ziel-Shop ${shop} ${hit ? `gefunden ("${hit.title}", ${hit.sales_channel})` : "NICHT in Liste"}`)
  } catch (e: any) { fail(`Printify: ${e.message}`) }
}

async function shopify() {
  try {
    const shop = process.env.SHOPIFY_STORE
    const token = process.env.SHOPIFY_ADMIN_TOKEN
    if (!shop || !token) return fail("Shopify: SHOPIFY_STORE/SHOPIFY_ADMIN_TOKEN fehlt")
    const r = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: "{ shop { name myshopifyDomain plan { displayName } } }" }),
    })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok) return fail(`Shopify: HTTP ${r.status}`)
    if (j.errors) return fail(`Shopify: ${JSON.stringify(j.errors).slice(0, 150)}`)
    ok(`Shopify: "${j.data?.shop?.name}" (${j.data?.shop?.myshopifyDomain}, Plan ${j.data?.shop?.plan?.displayName})`)
  } catch (e: any) { fail(`Shopify: ${e.message}`) }
}

async function gemini() {
  try {
    const key = process.env.GEMINI_API_KEY
    if (!key) return fail("Gemini: GEMINI_API_KEY fehlt")
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash?key=${encodeURIComponent(key)}`)
    if (!r.ok) return fail(`Gemini: HTTP ${r.status}`)
    const j: any = await r.json()
    ok(`Gemini: Modell erreichbar (${j.name || "gemini-2.5-flash"})`)
  } catch (e: any) { fail(`Gemini: ${e.message}`) }
}

async function drive() {
  try {
    if (!driveConfigured()) return fail("Drive: nicht konfiguriert (GOOGLE_SERVICE_ACCOUNT_JSON)")
    const folder = process.env.DRIVE_PRODUCTS_FOLDER_ID || process.argv[2]
    if (!folder) { ok("Drive: Service-Account konfiguriert (kein Folder zum Listen übergeben)"); return }
    const files = await driveListImages(folder)
    ok(`Drive: Service-Account ok, ${files.length} Bild(er) in Ordner ${folder}`)
  } catch (e: any) { fail(`Drive: ${e.message}`) }
}

;(async () => {
  console.log("=== API-Connection-Check ===")
  await printify()
  await shopify()
  await gemini()
  await drive()
})()
