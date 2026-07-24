// Fonction appelée depuis l'onglet "Réseaux sociaux" de l'app : à partir d'un
// court brief tapé par le café, génère plusieurs propositions de légende
// (+ hashtags) via l'API Google Gemini (offre gratuite, sans carte bancaire).
// L'IA ne publie rien : le café copie le texte généré et publie lui-même sur
// Instagram/Facebook.
//
// Secret requis (Project Settings > Edge Functions > Secrets) :
//   GEMINI_API_KEY : clé API Google Gemini, créée gratuitement sur
//                    https://aistudio.google.com/apikey (aucune carte requise
//                    pour le niveau gratuit).
//
// verify_jwt reste activé (comportement par défaut) : l'appel doit inclure
// l'API key Supabase (apikey / Authorization Bearer), comme tous les autres
// appels que fait déjà l'app à Supabase.

const GEMINI_MODEL = 'gemini-2.0-flash';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `Tu es le/la community manager du "Café Jean", un café-bar convivial et chaleureux.
Tu écris des légendes Instagram/Facebook pour ce café, à partir d'un brief court donné par le gérant.
Ton : chaleureux, local, sympathique, jamais ampoulé. 1 à 2 émojis pertinents maximum par légende.
Termine par un appel à l'action naturel (ex: "On vous attend !", "Passez nous voir", "DM pour réserver").

Réponds UNIQUEMENT avec un JSON strict, sans texte autour, de cette forme exacte :
{"captions":[{"style":"Court et punchy","texte":"..."},{"style":"Plus descriptif","texte":"..."},{"style":"Avec une touche d'humour","texte":"..."}],"hashtags":["#...","#..."]}
Fournis 5 à 8 hashtags en français, pertinents pour un café/bar (pas génériques type #love #instagood).`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Methode non supportee' }, 405);
  }

  try {
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY non configuree (Project Settings > Edge Functions > Secrets).');
    }

    const body = await req.json().catch(() => ({}));
    const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
    if (!brief) {
      return jsonResponse({ ok: false, error: 'Merci de decrire ce que vous voulez publier.' }, 400);
    }
    if (brief.length > 1000) {
      return jsonResponse({ ok: false, error: 'Description trop longue (max 1000 caracteres).' }, 400);
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: brief }] }],
          generationConfig: { temperature: 0.9 },
        }),
      },
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Appel Gemini echoue (${geminiRes.status}): ${errText.slice(0, 300)}`);
    }

    const geminiJson = await geminiRes.json();
    const parts = geminiJson?.candidates?.[0]?.content?.parts || [];
    const texte = parts.map((p: any) => p.text || '').join('').trim();

    let resultat;
    try {
      const jsonMatch = texte.match(/\{[\s\S]*\}/);
      resultat = JSON.parse(jsonMatch ? jsonMatch[0] : texte);
    } catch {
      resultat = { captions: [{ style: 'Proposition', texte }], hashtags: [] };
    }

    return jsonResponse({ ok: true, ...resultat });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: (err as Error).message }, 500);
  }
});
