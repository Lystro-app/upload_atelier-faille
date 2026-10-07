import express, { type Router } from "express";

const MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = [
  'Du benennst Kunst-Prints für die Marke "Atelier Faille".',
  "Schreibe ausschließlich auf Deutsch.",
  "Du lieferst ZWEI Paare: (A) kundenzugewandt für die Produktseite, (B) suchmaschinen-/AI-optimiert für die Meta-Felder.",
  "",
  "(A) KUNDEN — title & description:",
  "Ziel: Titel und Beschreibung sollen sich für Kundinnen und Kunden anfühlen wie etwas, das sie kaufen möchten — emotional, klar, ohne SEO-Geschwafel, ohne Keyword-Stuffing.",
  'Zielgruppe: Menschen, die ihr Zuhause stilvoll, sinnlich und persönlich gestalten. Keine Plattitüden wie "modern und stylisch", keine Marketing-Floskeln.',
  'title: max. 60 Zeichen. Eigenständig, konkret, gern poetisch. Keine generischen Begriffe wie "Wandbild", "Canvas Print", "Kunstdruck".',
  "description: 1–2 Sätze, max. 280 Zeichen. Beschreibt Stimmung, Atmosphäre und Wirkung im Raum — nicht Eigenschaften des Drucks.",
  "",
  "(B) SUCHMASCHINEN/AI — seoTitle & seoDescription:",
  "Hier IST Keyword-Nutzung erwünscht, aber natürlich lesbar (kein Stuffing). Deutsch.",
  'seoTitle: max. 60 Zeichen. Enthält einen konkreten Suchbegriff wie "Wandbild", "Leinwandbild" oder "Kunstdruck", plus Motiv/Stil und ggf. dominante Farbe (z. B. "Abstraktes Wandbild Beige — sanfte Formen"). KEIN Markenname (wird automatisch angehängt).',
  "seoDescription: max. 155 Zeichen. Ein natürlicher, einladender Satz mit relevanten Begriffen (z. B. Wandkunst, Premium-Canvas, Wohnzimmer/Schlafzimmer, versandkostenfrei). Beschreibt Motiv + Nutzen, endet mit leisem Kaufanreiz.",
  "",
  'Antworte ausschließlich als JSON: {"title": "...", "description": "...", "seoTitle": "...", "seoDescription": "..."}',
].join("\n");

interface TitleResult {
  title?: string;
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
}

// OpenAI (Vision) — genutzt wenn OPENAI_API_KEY gesetzt. Gleicher Prompt/Output.
async function titleViaOpenAI(
  imageBase64: string,
  mimeType: string,
  userText: string
): Promise<TitleResult> {
  const key = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: userText },
        {
          role: "user",
          content: [
            { type: "text", text: "Benenne dieses Motiv gemäß den Regeln. Antworte nur als JSON." },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const data: any = await r.json();
  const text: string = data?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(text);
}

async function titleViaGemini(
  imageBase64: string,
  mimeType: string,
  userText: string
): Promise<TitleResult> {
  const key = process.env.GEMINI_API_KEY!;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        { parts: [{ text: userText }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
  const data: any = await r.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return JSON.parse(text);
}

export function createGeminiRouter(): Router {
  const router = express.Router();

  router.post("/title", async (req, res) => {
    try {
      const { imageBase64, mimeType, hint } = req.body || {};
      if (!imageBase64 || !mimeType) {
        return res.status(400).json({ error: "imageBase64 and mimeType required" });
      }
      const useOpenAI = !!process.env.OPENAI_API_KEY;
      if (!useOpenAI && !process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: "OPENAI_API_KEY oder GEMINI_API_KEY erforderlich" });
      }
      const userText = hint ? `${SYSTEM_PROMPT}\n\nHinweis vom Nutzer: ${hint}` : SYSTEM_PROMPT;

      let parsed: TitleResult = {};
      try {
        parsed = useOpenAI
          ? await titleViaOpenAI(imageBase64, mimeType, userText)
          : await titleViaGemini(imageBase64, mimeType, userText);
      } catch (e: any) {
        return res.status(500).json({ error: e.message });
      }

      if (!parsed.title) {
        return res.status(500).json({ error: `no title in ${useOpenAI ? "OpenAI" : "Gemini"} response` });
      }
      res.json({
        title: parsed.title,
        description: parsed.description || "",
        seoTitle: parsed.seoTitle || "",
        seoDescription: parsed.seoDescription || "",
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
