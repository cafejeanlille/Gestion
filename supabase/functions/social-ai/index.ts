// Fonction appelée depuis l'onglet "Réseaux sociaux" de l'app : à partir d'un
// court brief tapé par le café, génère plusieurs propositions de légende
// (+ hashtags) via l'API Anthropic (Claude). L'IA ne publie rien : le café
// copie le texte généré et publie lui-même sur Instagram/Facebook.
//
// Secret requis (Project Settings > Edge Functions > Secrets) :
//   ANTHROPIC_API_KEY : clé API Anthropic (console.anthropic.com).
//
// verify_jwt reste activé (comportement par défaut) : l'appel doit inclure
// l'API key Supabase (apikey / Authorization Bearer), comme tous les autres
// appels que fait déjà l'app à Supabase.

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Methode non supportee' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY non configuree (Project Settings > Edge Functions > Secrets).');
    }

    const body = await req.json().catch(() => ({}));
    const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
    if (!brief) {
      return new Response(JSON.stringify({ ok: false, error: 'Merci de decrire ce que vous voulez publier.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    if (brief.length > 1000) {
      return new Response(JSON.stringify({ ok: false, error: 'Description trop longue (max 1000 caracteres).' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: brief }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      throw new Error(`Appel Anthropic echoue (${anthropicRes.status}): ${errText.slice(0, 300)}`);
    }

    const anthropicJson = await anthropicRes.json();
    const texte = (anthropicJson.content || []).map((b: any) => b.text || '').join('').trim();

    let resultat;
    try {
      const jsonMatch = texte.match(/\{[\s\S]*\}/);
      resultat = JSON.parse(jsonMatch ? jsonMatch[0] : texte);
    } catch {
      resultat = { captions: [{ style: 'Proposition', texte }], hashtags: [] };
    }

    return new Response(JSON.stringify({ ok: true, ...resultat }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
});
