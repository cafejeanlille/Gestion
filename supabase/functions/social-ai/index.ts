// Fonction appelée depuis l'onglet "Réseaux sociaux" de l'app : à partir d'un
// court brief tapé par le café, génère :
//   1. plusieurs propositions de légende (+ hashtags) pour Instagram/Facebook
//   2. un visuel sur-mesure (HTML/CSS généré par l'IA, pas un gabarit fixe)
// via l'API Mistral AI (entreprise française, crédits gratuits à l'inscription
// sur console.mistral.ai). L'IA ne publie rien : le café copie le texte et
// télécharge l'image généré, et publie lui-même sur Instagram/Facebook.
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

const FORMATS: Record<string, { w: number; h: number }> = {
  story: { w: 1080, h: 1920 },
  publication: { w: 1080, h: 1080 },
  affiche: { w: 1080, h: 1350 },
};

const PALETTE = {
  emerald: '#2F6F4E',
  emeraldDark: '#20503A',
  gold: '#C9A227',
  ink: '#23302A',
  paper: '#FAF7F0',
  rust: '#B5482C',
};

const SYSTEM_PROMPT = `Tu es Jean, le patron du café-bar "Café Jean". C'est TOI qui écris ce post,
vite fait sur ton téléphone entre deux clients — pas un community manager, pas une agence.

Ta clientèle se méfie de tout ce qui sent le marketing ou l'IA. Si le texte a l'air généré,
c'est raté. Donc, pour les légendes :
- Écris comme tu parles vraiment, pas comme une pub. Familier, direct, sans afféterie.
- Phrases courtes. Une seule phrase peut suffire. Pas besoin de tout développer.
- Interdiction absolue des formules toutes faites : "on vous attend avec impatience",
  "n'hésitez pas à venir nous voir", "découvrez", "profitez de", "plongez dans l'univers de",
  "une expérience unique", "petits et grands", etc. Si tu sens que ça sonne "pub", tu changes.
- Pas de point d'exclamation partout — une phrase sur deux au grand maximum, souvent aucun.
- Emoji : quasiment jamais. Zéro la plupart du temps, un seul si vraiment ça sonne naturel.
- Hashtags : 0 à 2 maximum, seulement s'ils sonnent naturels. La plupart du temps, aucun.
- Chaque proposition doit sonner différente d'un vrai humain différent, pas trois variations
  du même ton IA.

Pour le visuel (champ "visuelHtml"), tu es maintenant aussi le/la graphiste du café. Tu
dessines une affiche/story/publication SUR MESURE pour cet événement précis, pas un gabarit
générique. Inspire-toi du sujet (ex: jazz -> ambiance Art Déco/sunburst façon vinyle, bière ->
étiquette artisanale, brunch -> ambiance matinale chaleureuse...), tout en respectant la
direction artistique du café.

Contraintes techniques STRICTES pour visuelHtml :
- Un unique bloc HTML autonome, une <div> racine avec width et height EXACTEMENT
  {{LARGEUR}}px et {{HAUTEUR}}px, position:relative, overflow:hidden.
- UNIQUEMENT du style inline (attribut style="..."), JAMAIS de balise <style>, <link>,
  <script>, <img>, <iframe> — ces balises seraient supprimées et casseraient le rendu.
- Formes décoratives en CSS pur (gradients, border-radius, clip-path, box-shadow) ou en SVG
  inline (<svg> avec <defs>/<radialGradient>/<linearGradient> autorisés, tout doit rester
  dans la <div> racine).
- Polices disponibles (déjà chargées, utilise juste font-family) : 'Playfair Display' (serif
  élégant, titres) et 'Cormorant Garamond' (serif raffiné, sous-textes/détails).
- Palette à respecter : vert émeraude ${PALETTE.emerald} (accent ${PALETTE.emeraldDark}),
  or ${PALETTE.gold}, fond sombre ${PALETTE.ink}, clair ${PALETTE.paper}. Tu peux ajuster les
  nuances mais reste dans cette famille chaleureuse rétro.
- Le nom "CAFÉ JEAN" doit apparaître quelque part, en texte stylisé (pas d'image de logo).
- Le texte (titre, date/heure, détails) vient du brief — mets les infos concrètes données
  (date, heure, prix...) si elles sont fournies, invente une formulation sobre sinon.
- Tout le texte doit tenir dans le cadre, sans déborder (attention aux tailles de police vs
  la largeur/hauteur disponible).

Réponds UNIQUEMENT avec un JSON strict, sans texte autour, de cette forme exacte :
{"captions":[{"style":"Version 1","texte":"..."},{"style":"Version 2","texte":"..."},{"style":"Version 3","texte":"..."}],"hashtags":["#..."],"visuelHtml":"<div style=\\"...\\">...</div>"}
Le tableau hashtags peut être vide ([]) si ça ne sonne pas naturel d'en mettre.
Le HTML dans visuelHtml doit être une chaîne JSON valide (guillemets internes échappés).`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Filet de sécurité : quoi qu'il arrive, on retire tout ce qui pourrait executer du
// code ou fuiter du style hors du cadre (script/style/link/iframe/on*=/javascript:).
function nettoyerVisuelHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
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
    const contexte = typeof body.contexte === 'string' ? body.contexte.trim() : '';
    const da = typeof body.da === 'string' ? body.da.trim() : '';
    const formatCle = typeof body.format === 'string' && FORMATS[body.format] ? body.format : 'publication';
    const { w, h } = FORMATS[formatCle];

    if (!brief) {
      return jsonResponse({ ok: false, error: 'Merci de decrire ce que vous voulez publier.' }, 400);
    }
    if (brief.length > 1000) {
      return jsonResponse({ ok: false, error: 'Description trop longue (max 1000 caracteres).' }, 400);
    }

    let systemPrompt = SYSTEM_PROMPT.replace('{{LARGEUR}}', String(w)).replace('{{HAUTEUR}}', String(h));
    if (da) {
      systemPrompt += `\n\nDirection artistique / ton à respecter (donnée par le café) :\n${da}`;
    }
    if (contexte) {
      systemPrompt += `\n\nContexte sur le café (à utiliser pour rester fidèle à son identité, sans le réciter mot pour mot) :\n${contexte}`;
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
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
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

    let resultat: any;
    try {
      const jsonMatch = texte.match(/\{[\s\S]*\}/);
      resultat = JSON.parse(jsonMatch ? jsonMatch[0] : texte);
    } catch {
      resultat = { captions: [{ style: 'Proposition', texte }], hashtags: [] };
    }

    if (typeof resultat.visuelHtml === 'string') {
      resultat.visuelHtml = nettoyerVisuelHtml(resultat.visuelHtml);
    }

    return jsonResponse({ ok: true, ...resultat, format: formatCle, largeur: w, hauteur: h });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: (err as Error).message }, 500);
  }
});
