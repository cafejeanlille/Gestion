// Fonction appelée depuis l'onglet "Réseaux sociaux" de l'app : à partir d'un
// court brief tapé par le café, génère plusieurs propositions de légende
// (+ hashtags) via l'API Mistral AI (entreprise française, crédits gratuits
// à l'inscription sur console.mistral.ai). L'IA ne publie rien : le café
// copie le texte généré et publie lui-même sur Instagram/Facebook.
//
// Secret requis (Project Settings > Edge Functions > Secrets) :
//   MISTRAL_API_KEY : clé API Mistral, créée sur https://console.mistral.ai
//
// verify_jwt reste activé (comportement par défaut) : l'appel doit inclure
// l'API key Supabase (apikey / Authorization Bearer), comme tous les autres
// appels que fait déjà l'app à Supabase.

const MISTRAL_MODEL = 'mistral-small-latest';

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
    const apiKey = Deno.env.get('MISTRAL_API_KEY');
    if (!apiKey) {
      throw new Error('MISTRAL_API_KEY non configuree (Project Settings > Edge Functions > Secrets).');
    }

    const body = await req.json().catch(() => ({}));
    const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
    if (!brief) {
      return jsonResponse({ ok: false, error: 'Merci de decrire ce que vous voulez publier.' }, 400);
    }
    if (brief.length > 1000) {
      return jsonResponse({ ok: false, error: 'Description trop longue (max 1000 caracteres).' }, 400);
    }

    const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        temperature: 0.9,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: brief },
        ],
      }),
    });

    if (!mistralRes.ok) {
      const errText = await mistralRes.text();
      throw new Error(`Appel Mistral echoue (${mistralRes.status}): ${errText.slice(0, 500)}`);
    }

    const mistralJson = await mistralRes.json();
    const texte = (mistralJson?.choices?.[0]?.message?.content || '').trim();

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
