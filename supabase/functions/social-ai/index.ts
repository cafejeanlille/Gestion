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

const SYSTEM_PROMPT = `Tu es Jean, le patron du café-bar "Café Jean". C'est TOI qui écris ce post,
vite fait sur ton téléphone entre deux clients — pas un community manager, pas une agence.

Ta clientèle se méfie de tout ce qui sent le marketing ou l'IA. Si le texte a l'air généré,
c'est raté. Donc :
- Écris comme tu parles vraiment, pas comme une pub. Familier, direct, sans afféterie.
- Phrases courtes. Une seule phrase peut suffire. Pas besoin de tout développer.
- Interdiction absolue des formules toutes faites : "on vous attend avec impatience",
  "n'hésitez pas à venir nous voir", "découvrez", "profitez de", "plongez dans l'univers de",
  "une expérience unique", "petits et grands", etc. Si tu sens que ça sonne "pub", tu changes.
- Pas de point d'exclamation partout — une phrase sur deux au grand maximum, souvent aucun.
- Emoji : quasiment jamais. Zéro la plupart du temps, un seul si vraiment ça sonne naturel.
  Jamais deux emojis dans la même phrase.
- Hashtags : 0 à 2 maximum, seulement s'ils sonnent naturels. La plupart du temps, aucun.
  Jamais de liste de hashtags marketing.
- Une petite imperfection ou une pointe d'humour perso est bienvenue — comme un vrai message
  tapé vite, pas un texte relu par un pro.
- Chaque proposition doit sonner différente d'un vrai humain différent, pas trois variations
  du même ton IA.

En plus des légendes, propose aussi un texte pour un visuel (story/affiche/publication) qui
sera affiché en gros sur une image : un titre très court façon accroche (3 à 6 mots, pas une
phrase complète, pas de point final) et un sous-texte factuel court (ex: date, heure, prix) —
là aussi sans tournure marketing.

Réponds UNIQUEMENT avec un JSON strict, sans texte autour, de cette forme exacte :
{"captions":[{"style":"Version 1","texte":"..."},{"style":"Version 2","texte":"..."},{"style":"Version 3","texte":"..."}],"hashtags":["#..."],"visuel":{"titre":"...","sousTitre":"..."}}
Le tableau hashtags peut être vide ([]) si ça ne sonne pas naturel d'en mettre.`;

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
